/**
 * agbossjs/agboss#613 on PostgreSQL, through the application's container: the record store mints
 * through the core's check around the listed generator, and its refusal after 100 taken ids is
 * `DuplicateThreadIdError` naming the project's class (`idGeneratorNameOf`), never the check's,
 * never an id. Built with the public `createApp` on the test's own schema.
 */
import { createApp, DuplicateThreadIdError, IdGenerator, Injectable } from "@agboss/core";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresExecutionRecordRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";
import { testDatabase } from "../support/database.js";

const database = testDatabase();

/** Mints `thread-1` for ever. */
@Injectable()
class StuckIdGenerator extends IdGenerator {
  newThreadId(): string {
    return "thread-1";
  }

  newExecutionId(): string {
    return "execution-1";
  }
}

beforeAll(() => {
  process.env.AGBOSS_PROCESS_DATABASE_URL = database.url();
  process.env.AGBOSS_PROCESS_MESH_PEER_KEY = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
});

describe("agbossjs/agboss#613: a minted thread id that never finds a free one, on PostgreSQL", () => {
  it("through the core's check around the listed generator: DuplicateThreadIdError naming the project's class", async () => {
    const app = await createApp(
      storeLayoutOf([
        StuckIdGenerator,
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
      const thread = { workflow: "desk-workflow", tenantId: "default" };
      await records.createThread(thread);

      const refused = await records.createThread(thread).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(DuplicateThreadIdError);
      expect(refused).toMatchObject({
        code: "run.duplicate-thread-id",
        generator: "StuckIdGenerator",
        tries: 100,
      });
      expect(String(refused)).not.toContain("thread-1");
    } finally {
      await app.close();
    }
  });
});
