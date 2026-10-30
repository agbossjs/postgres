import { describe, expect, it } from "vitest";
import { once } from "../../src/connection/once.js";
import { changesOf, firstRowOf, rowsOf } from "../../src/connection/query.js";
import { inPoolTransaction, inTransaction } from "../../src/connection/transaction.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase({ migrated: false });

describe("the statements and transactions of the stores", () => {
  it("rowsOf / firstRowOf give rows; changesOf counts, 0 for a statement without a count", async () => {
    const { pool } = connectionTo(database.url());

    expect(await changesOf(pool, "CREATE TABLE numbers (n integer)")).toBe(0);
    expect(await changesOf(pool, "INSERT INTO numbers VALUES (1), (2)")).toBe(2);
    expect(await rowsOf(pool, "SELECT n FROM numbers ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await firstRowOf(pool, "SELECT n FROM numbers WHERE n > $1", [5])).toBeUndefined();
  });

  it("a transaction's work that throws is rolled back, its error rethrown as it is", async () => {
    const { pool } = connectionTo(database.url());
    await changesOf(pool, "CREATE TABLE letters (l text)");
    const declined = new Error("declined");

    await expect(
      inPoolTransaction(pool, async (client) => {
        await client.query("INSERT INTO letters VALUES ('a')");
        throw declined;
      }),
    ).rejects.toBe(declined);
    const client = await pool.connect();
    try {
      await expect(
        inTransaction(client, async () => {
          await client.query("INSERT INTO letters VALUES ('b')");
          throw declined;
        }),
      ).rejects.toBe(declined);
    } finally {
      client.release();
    }

    expect(await rowsOf(pool, "SELECT l FROM letters")).toEqual([]);
  });

  it("a connection whose rollback fails is not given back to the pool", async () => {
    const { pool } = connectionTo(database.url(), 1);
    const pids = new Set<unknown>();

    await expect(
      inPoolTransaction(pool, async (client) => {
        pids.add(await firstRowOf(client, "SELECT pg_backend_pid() AS pid"));
        await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
      }),
    ).rejects.toThrow();
    pids.add(await firstRowOf(pool, "SELECT pg_backend_pid() AS pid"));

    expect(pids.size).toBe(2);
  });
});

describe("once", () => {
  it("runs once and shares the result; a failure is not kept", async () => {
    let calls = 0;
    const flaky = once(async () => {
      calls += 1;
      if (calls === 1) throw new Error("not yet");
      return calls;
    });

    await expect(flaky()).rejects.toThrow("not yet");
    expect(await Promise.all([flaky(), flaky()])).toEqual([2, 2]);
    expect(await flaky()).toBe(2);
    expect(calls).toBe(2);
  });
});
