import type { EffectKey } from "@agboss/core/stores";
import type { PoolClient } from "pg";
import { firstRowOf } from "../../connection/query.js";
import { whereOf } from "./outbound-call-rows.js";

/**
 * The row of `key` (`SELECT record …`): by its step, or by its tenant, name and business key — and
 * after a rotation of the idempotency secret (agbossjs/agboss#1317d) by the digest the previous
 * secret made of that business key. `undefined` when there is none.
 */
export async function foundRowOf(client: PoolClient, key: EffectKey): Promise<unknown> {
  const { scopeKey, idempotencyKey, name, tenantId } = key;
  const identities =
    key.businessKey === undefined ? [undefined] : [key.businessKey, key.previousBusinessKey];
  for (const businessKey of identities) {
    if (businessKey === undefined && key.businessKey !== undefined) continue;
    const [where, values] = whereOf({ scopeKey, idempotencyKey, name, tenantId, businessKey }, 1);
    const row = await firstRowOf(
      client,
      `SELECT record FROM agboss_outbound_calls WHERE ${where}`,
      values,
    );
    if (row !== undefined) return row;
  }
  return undefined;
}
