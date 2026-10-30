import { randomUUID } from "node:crypto";
import {
  ApplicationContext,
  Clock,
  Injectable,
  RateLimitRepository,
  type RateLimitLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { z } from "zod";
import { PostgresConnection } from "../connection/postgres-connection.js";
import { changesOf, firstRowOf } from "../connection/query.js";
import { inPoolTransaction } from "../connection/transaction.js";
import {
  countInBucket,
  forgetBefore,
  lockKey,
  PAUSE,
  RENEW_SLOT,
  TAKE_SLOT,
  windowTotal,
} from "./rate-limits/rate-limit-statements.js";

const PauseRow = z.object({ paused_until: z.date() });

/**
 * `RateLimitRepository` on PostgreSQL (agbossjs/agboss#483): a provider's `maxConcurrentCalls`,
 * per-minute windows, 429 pause and circuit breaker shared by every instance of the application.
 *
 * - **Slots** are rows with a lease. `acquire` is one transaction: the key's row `SELECT … FOR
 *   UPDATE` (made first when new), then one statement that sweeps the key's expired slots and
 *   inserts the new one under the count of the valid ones — so two instances never hold more than
 *   `maxSlots` together. `renew` extends only a slot still valid (`expires_at > now`); `release`
 *   deletes it. Both are one statement.
 * - **Windows** are counted in buckets of one `Clock` millisecond. `addToWindow` locks the key's
 *   row as `acquire` does, forgets the buckets that left the window, sums the rest and adds to the
 *   bucket of now only when the limit allows; a plain read (`amount` 0, no limit) is one `SELECT`
 *   of the window, without the lock.
 * - **Pauses** (a 429, an open breaker) are rows; `pauseUntil` keeps the later one (`GREATEST`).
 *
 * Times are the framework `Clock`'s, passed as parameters. `READ COMMITTED` throughout. Listed in
 * `@Application({ providers })` with `postgresUrl`.
 */
@Injectable({ deps: [PostgresConnection, Clock, ApplicationContext] })
export class PostgresRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly connection: PostgresConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  acquire(key: string, maxSlots: number, lease: Milliseconds): Promise<RateLimitLease | undefined> {
    const now = this.clock.now();
    const slot: RateLimitLease = {
      key,
      slotId: randomUUID(),
      holderInstanceId: this.applicationContext.instanceId,
      expiresAt: new Date(now.getTime() + lease),
    };
    return inPoolTransaction(this.connection.pool, async (client) => {
      await lockKey(client, key);
      const taken = await changesOf(client, TAKE_SLOT, [
        slot.slotId,
        key,
        slot.holderInstanceId,
        slot.expiresAt,
        maxSlots,
        now,
      ]);
      return taken === 1 ? slot : undefined;
    });
  }

  async renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const now = this.clock.now();
    const renewed = await changesOf(this.connection.pool, RENEW_SLOT, [
      new Date(now.getTime() + lease),
      rateLimitLease.slotId,
      now,
    ]);
    return renewed === 1;
  }

  async release(rateLimitLease: RateLimitLease): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_rate_limit_slots WHERE slot_id = $1",
      [rateLimitLease.slotId],
    );
  }

  addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - window);
    if (amount === 0 && limit === undefined) return windowTotal(this.connection.pool, key, since);
    return inPoolTransaction(this.connection.pool, async (client) => {
      await lockKey(client, key);
      await forgetBefore(client, key, since);
      const total = (await windowTotal(client, key, since)) + amount;
      if (limit !== undefined && total > limit) return undefined;
      if (amount !== 0) await countInBucket(client, key, now, amount);
      return total;
    });
  }

  async clearWindow(key: string): Promise<void> {
    await changesOf(
      this.connection.pool,
      "DELETE FROM agboss_rate_limit_window_buckets WHERE window_key = $1",
      [key],
    );
  }

  async pauseUntil(key: string, until: Date): Promise<void> {
    await changesOf(this.connection.pool, PAUSE, [key, until]);
  }

  async pausedUntil(key: string): Promise<Date | undefined> {
    const row = await firstRowOf(
      this.connection.pool,
      "SELECT paused_until FROM agboss_rate_limit_pauses WHERE pause_key = $1",
      [key],
    );
    if (row === undefined) return undefined;
    const { paused_until: until } = PauseRow.parse(row);
    return until.getTime() > this.clock.now().getTime() ? until : undefined;
  }
}
