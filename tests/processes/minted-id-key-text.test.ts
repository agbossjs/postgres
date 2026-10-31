/**
 * agbossjs/agboss#578 on PostgreSQL: a thread id the application's own `IdGenerator` mints is held
 * to the key-text rules at the mint — `x\uD800` and `x\uDFFF` would both be `x�` in the
 * database's UTF-8, one thread, one tree. The PostgreSQL record store mints through the generator
 * the application's container gives it, so it refuses with `InvalidMintedIdError` (the generator,
 * the method and the rule, never the id) before any row is written; a valid id still makes its
 * thread. Built with the public `createApp` on the test's own schema.
 */
import {
  createApp,
  IdGenerator,
  Injectable,
  InvalidMintedIdError,
  KeyTextRule,
} from "@agboss/core";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";

const database = testDatabase();

/** The thread ids the generator mints next. */
const planned: string[] = [];

/** Mints the planned thread ids, else `thread-ok`. */
@Injectable()
class PlannedIdGenerator extends IdGenerator {
  newThreadId(): string {
    return planned.shift() ?? "thread-ok";
  }

  newExecutionId(): string {
    return "execution-ok";
  }
}

beforeAll(() => {
  process.env.AGBOSS_PROCESS_DATABASE_URL = database.url();
  process.env.AGBOSS_PROCESS_MESH_PEER_KEY = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
});

beforeEach(async () => {
  planned.length = 0;
  await onSchema(database.url(), "TRUNCATE agboss_threads CASCADE");
});

const threadRows = async (): Promise<number> =>
  Number((await onSchema(database.url(), "SELECT count(*) AS n FROM agboss_threads")).rows[0]?.n);

describe("agbossjs/agboss#578: a minted thread id on PostgreSQL is a key's text", () => {
  it("x\\uD800, then x\\uDFFF: both refused before a row is written; a valid id makes its thread", async () => {
    const app = await createApp(
      storeLayoutOf([
        PlannedIdGenerator,
        PostgresExecutionLeaseRepository,
        PostgresFencedEffectRepository,
        PostgresOutboundCallRepository,
        PostgresExecutionRecordRepository,
      ]),
      { env: "process" },
    );
    try {
      const records = app.resolve<PostgresExecutionRecordRepository>(
        PostgresExecutionRecordRepository,
      );
      planned.push("x\uD800", "x\uDFFF");
      const thread = { workflow: "charge-workflow", tenantId: "default" };

      const first = await records.createThread(thread).catch((error: unknown) => error);
      const second = await records.createThread(thread).catch((error: unknown) => error);

      for (const refused of [first, second]) {
        expect(refused).toBeInstanceOf(InvalidMintedIdError);
        expect(refused).toMatchObject({
          generator: "PlannedIdGenerator",
          method: "newThreadId",
          rule: KeyTextRule.LoneSurrogate,
        });
        expect((refused as Error).message).not.toContain("x\uD800");
        expect((refused as Error).message).not.toContain("x\uDFFF");
      }
      expect(await threadRows()).toBe(0);
      expect(await records.createThread(thread)).toBe("thread-ok");
      expect(await threadRows()).toBe(1);
    } finally {
      await app.close();
    }
  });
});
