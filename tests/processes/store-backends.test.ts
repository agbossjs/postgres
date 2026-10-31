/**
 * agbossjs/agboss#526 AC1 on PostgreSQL: the three fencing stores declare `backend = "postgres"`,
 * so assembly holds a fenced-effect or outbound-call store to the application's lease store. A
 * mixed layout — PostgreSQL leases with in-memory or SQLite fenced effects or outbound calls, or
 * the reverse — fails with `[application.store-backend-mismatch]`, naming both stores and both
 * backends, every violation at once. The all-PostgreSQL layout assembles, and so do PostgreSQL
 * leases with the in-memory rate limits and child queue (the core's defaults, unlisted) or a SQLite
 * lease log: no atomic step spans them. Built with the public `createApp`, on the test's own
 * schema (`tests/fixtures/store-layout.application.ts`); an application that assembles is closed
 * again.
 */
import {
  createApp,
  GraphRuleError,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  type Class,
} from "@agboss/core";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PostgresExecutionLeaseRepository,
  PostgresFencedEffectRepository,
  PostgresOutboundCallRepository,
} from "../../src/index.js";
import { testDatabase } from "../support/database.js";
import { HeldPostgresExecutionLeaseRepository } from "../fixtures/held-lease.repository.js";
import { storeLayoutOf } from "../fixtures/store-layout.application.js";

type Provider = Class;

const database = testDatabase();

beforeAll(() => {
  process.env.AGBOSS_PROCESS_DATABASE_URL = database.url();
  process.env.AGBOSS_PROCESS_MESH_PEER_KEY = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
});

/** The store-backend violations of assembling `providers`, as `[code] message`. */
async function backendViolationsOf(providers: readonly Provider[]): Promise<readonly string[]> {
  const error: unknown = await createApp(storeLayoutOf(providers), { env: "process" }).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return [];
  if (error instanceof Error && !(error instanceof GraphRuleError)) throw error;
  if (!(error instanceof GraphRuleError)) throw new Error("the assembly threw a non-error");
  return error.violations
    .filter((found) => found.code.startsWith("application.store-backend"))
    .map((found) => `[${found.code}] ${found.message}`);
}

/** Assembles `providers` and closes the application: any assembly error is thrown. */
async function assembled(providers: readonly Provider[]): Promise<true> {
  const app = await createApp(storeLayoutOf(providers), { env: "process" });
  await app.close();
  return true;
}

/** A `[application.store-backend-mismatch]` naming both stores and both backends. */
const mismatch = (
  fencing: string,
  backend: string,
  leases: string,
  leaseBackend: string,
): unknown =>
  expect.stringMatching(
    new RegExp(
      `^\\[application\\.store-backend-mismatch\\] ${fencing} \\(backend "${backend}"\\) .*${leases} \\(backend "${leaseBackend}"\\)`,
      "u",
    ),
  );

const PG_LEASES = "PostgresExecutionLeaseRepository";
const PG_EFFECTS = "PostgresFencedEffectRepository";
const PG_CALLS = "PostgresOutboundCallRepository";

describe("#526 AC1: PostgreSQL leases with fencing stores of another backend fail assembly", () => {
  it.each([
    [InMemoryFencedEffectRepository, "in-memory"],
    [SqliteFencedEffectRepository, "sqlite"],
    [InMemoryOutboundCallRepository, "in-memory"],
    [SqliteOutboundCallRepository, "sqlite"],
  ] as const)("PostgreSQL leases with %o → store-backend-mismatch", async (store, backend) => {
    expect(await backendViolationsOf([PostgresExecutionLeaseRepository, store])).toEqual([
      mismatch(store.name, backend, PG_LEASES, "postgres"),
    ]);
  });

  it("PostgreSQL leases and fenced effects with SQLite outbound calls → only the calls are named", async () => {
    const providers = [PostgresExecutionLeaseRepository, PostgresFencedEffectRepository];
    expect(await backendViolationsOf([...providers, SqliteOutboundCallRepository])).toEqual([
      mismatch("SqliteOutboundCallRepository", "sqlite", PG_LEASES, "postgres"),
    ]);
  });
});

describe("#526 AC1: PostgreSQL fencing stores with leases of another backend fail assembly", () => {
  it.each([
    [PostgresFencedEffectRepository, PG_EFFECTS],
    [PostgresOutboundCallRepository, PG_CALLS],
  ] as const)(
    "%o with the default in-memory leases → store-backend-mismatch",
    async (store, name) => {
      expect(await backendViolationsOf([store])).toEqual([
        mismatch(name, "postgres", "InMemoryExecutionLeaseRepository", "in-memory"),
      ]);
    },
  );

  it.each([
    [PostgresFencedEffectRepository, PG_EFFECTS],
    [PostgresOutboundCallRepository, PG_CALLS],
  ] as const)("%o with SQLite leases → store-backend-mismatch", async (store, name) => {
    expect(await backendViolationsOf([SqliteExecutionLeaseRepository, store])).toEqual([
      mismatch(name, "postgres", "SqliteExecutionLeaseRepository", "sqlite"),
    ]);
  });

  it("both PostgreSQL fencing stores with SQLite leases → both reported at once", async () => {
    const providers = [PostgresFencedEffectRepository, PostgresOutboundCallRepository];
    expect(await backendViolationsOf([SqliteExecutionLeaseRepository, ...providers])).toEqual(
      expect.arrayContaining([
        mismatch(PG_EFFECTS, "postgres", "SqliteExecutionLeaseRepository", "sqlite"),
        mismatch(PG_CALLS, "postgres", "SqliteExecutionLeaseRepository", "sqlite"),
      ]),
    );
    expect(await backendViolationsOf([SqliteExecutionLeaseRepository, ...providers])).toHaveLength(
      2,
    );
  });
});

describe("#526 AC1: the layouts PostgreSQL supports assemble", () => {
  const ALL_FENCING = [
    PostgresExecutionLeaseRepository,
    PostgresFencedEffectRepository,
    PostgresOutboundCallRepository,
  ];

  it("leases, fenced effects and outbound calls on PostgreSQL", async () => {
    expect(PostgresExecutionLeaseRepository.backend).toBe("postgres");
    expect(PostgresFencedEffectRepository.backend).toBe("postgres");
    expect(PostgresOutboundCallRepository.backend).toBe("postgres");
    expect(await assembled(ALL_FENCING)).toBe(true);
  });

  it("PostgreSQL leases with the in-memory rate limits and child queue (unlisted): not constrained", async () => {
    // ALL_FENCING lists no rate-limit or queue store: the core's in-memory ones serve them
    expect(await assembled(ALL_FENCING)).toBe(true);
    expect(await backendViolationsOf([PostgresExecutionLeaseRepository])).toEqual([]);
  });

  it("a subclass of the PostgreSQL lease store inherits its backend (the process tests' layout)", async () => {
    expect(HeldPostgresExecutionLeaseRepository.backend).toBe("postgres");
    const fencing = [PostgresFencedEffectRepository, PostgresOutboundCallRepository];
    expect(await assembled([HeldPostgresExecutionLeaseRepository, ...fencing])).toBe(true);
  });

  it("PostgreSQL leases with a lease log of another backend: not constrained", async () => {
    expect(
      await backendViolationsOf([...ALL_FENCING, SqliteExecutionLeaseEventRepository]),
    ).toEqual([]);
  });
});
