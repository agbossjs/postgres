import type { ExecutionTreeValue, MeshRequestKey, MeshRequestRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { PostgresExecutionTreeRepository, PostgresMeshRequestRepository } from "../../src/index.js";
import { onSchema, testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * Acceptance corner cases (agbossjs/agboss#521 AC4, #483 AC4) on a real PostgreSQL: text that holds
 * the escape character itself — U+E000 before `0`, doubled, at the end, in an object key — reads
 * back as written through the stores, beside NUL and characters outside the BMP; and ten saves of
 * one mesh request racing on two instances admit it once.
 */
const database = testDatabase();

const ESCAPE = "";
const HARD = [
  "\u0000",
  ESCAPE,
  `${ESCAPE}0`,
  `${ESCAPE}${ESCAPE}0`,
  `${ESCAPE}\u0000`,
  `\u0000${ESCAPE}`,
  `ends with ${ESCAPE}`,
  `${ESCAPE}${ESCAPE}${ESCAPE}`,
  "\\u0000 and \\uE000 spelled out",
  "счёт \u{1F9FE} 7\u0000",
];

/** Every hard string as a value, in a list and as an object key. */
const hardValue = (): ExecutionTreeValue => ({
  values: HARD,
  keyed: Object.fromEntries(HARD.map((text, index) => [text, index])),
  nested: [{ [ESCAPE]: { [`${ESCAPE}0`]: HARD } }],
});

const keyOf = (idempotencyKey: string): MeshRequestKey => ({
  tenantId: "acme",
  peer: "orders-application",
  idempotencyKey,
});

describe("#521 AC4 acceptance: the escape character itself round-trips", () => {
  it("AC4: a tree value with U+E000 sequences and NUL in values and keys reads back equal", async () => {
    const tree = new PostgresExecutionTreeRepository(connectionTo(database.url()));
    const at = { tenantId: "default", rootExecutionId: "root-escape" };

    expect(await tree.saveIfAbsentInTree(at, "plan", hardValue())).toBe(true);

    expect(await tree.findByIdInTree(at, "plan")).toEqual(hardValue());
  });

  it("AC4: a mesh answer with them, read by another instance, is the answer as written", async () => {
    const [a, b] = [
      new PostgresMeshRequestRepository(connectionTo(database.url())),
      new PostgresMeshRequestRepository(connectionTo(database.url())),
    ];
    await a.saveIfAbsent({ ...keyOf("escape"), createdAt: "2026-01-05T09:00:00.000Z" });

    await a.saveResponse(keyOf("escape"), hardValue());

    expect((await b.findByKey(keyOf("escape")))?.response).toEqual(hardValue());
  });
});

describe("#483 AC4 acceptance: a mesh request retried against many pods at once", () => {
  /** A naive save: look first, then write — the check-then-act the store must not be. */
  class LookThenWrite extends PostgresMeshRequestRepository {
    override async saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
      if ((await this.findByKey(record)) !== undefined) return false;
      await onSchema(
        database.url(),
        `INSERT INTO agboss_mesh_requests (tenant_id, peer, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [record.tenantId, record.peer, record.idempotencyKey, record.createdAt],
      );
      return true;
    }
  }

  /** Ten saves of one key on two instances at once: how many were admitted. */
  const admittedOf = async (key: string, Store = PostgresMeshRequestRepository) => {
    const [a, b] = [
      new Store(connectionTo(database.url())),
      new Store(connectionTo(database.url())),
    ];
    const admitted = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? a : b).saveIfAbsent({
          ...keyOf(key),
          createdAt: `2026-01-05T09:00:0${String(index)}.000Z`,
        }),
      ),
    );
    return admitted.filter(Boolean).length;
  };

  it("AC4: ten saves of one key racing on two instances: exactly one admits it", async () => {
    expect(await admittedOf("raced")).toBe(1);
  });

  it("AC4: the race check bites — a look-then-write store admits the retry more than once", async () => {
    expect(await admittedOf("naive", LookThenWrite)).toBeGreaterThan(1);
  });
});
