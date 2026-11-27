import { IdempotencyError } from "@agboss/core";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  requiredTransaction,
  requirePostgresTransaction,
  withAmbientTransaction,
} from "../../src/connection/ambient.js";
import { recordedPool } from "./recorded-pool.js";

/**
 * The transaction of the `runOnce` the caller is inside of (agbossjs/agboss#1317c), with no database:
 * per owner (a connection), the innermost one for a caller that names none, and outside any of them
 * `IdempotencyError.OutsideTransaction` naming what to do.
 */
/** A connection that never connects: each call lends another one. */
const clientOf = (): Promise<PoolClient> => recordedPool().pool.connect();
const refusal = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("outside a runOnce", () => {
  it("neither lookup finds a transaction: IdempotencyError.OutsideTransaction, saying where it is taken", () => {
    for (const lookup of [() => requiredTransaction({}), () => requirePostgresTransaction()]) {
      const error = refusal(lookup);

      expect(error).toBeInstanceOf(IdempotencyError.OutsideTransaction);
      expect(String(error)).toContain(
        "requireTransaction() was called outside an Idempotency.runOnce",
      );
    }
  });
});

describe("inside a runOnce", () => {
  it("an owner finds its own transaction; another owner, or none, does not", async () => {
    const [owner, other] = [{}, {}];
    const client = await clientOf();

    await withAmbientTransaction(owner, client, () => {
      expect(requiredTransaction(owner)).toBe(client);
      expect(refusal(() => requiredTransaction(other))).toBeInstanceOf(
        IdempotencyError.OutsideTransaction,
      );
      // an owner that is nothing at all is nobody's
      expect(refusal(() => requiredTransaction(undefined as never))).toBeInstanceOf(
        IdempotencyError.OutsideTransaction,
      );
      return Promise.resolve();
    });
  });

  it("nested runs: each owner finds its own, the caller that names none the innermost, and the outer one again after", async () => {
    const [outer, inner] = [{}, {}];
    const [first, second] = [await clientOf(), await clientOf()];

    await withAmbientTransaction(outer, first, async () => {
      await withAmbientTransaction(inner, second, () => {
        expect(requiredTransaction(outer)).toBe(first);
        expect(requiredTransaction(inner)).toBe(second);
        expect(requirePostgresTransaction()).toBe(second);
        return Promise.resolve();
      });
      expect(requirePostgresTransaction()).toBe(first);
      expect(refusal(() => requiredTransaction(inner))).toBeInstanceOf(
        IdempotencyError.OutsideTransaction,
      );
    });
    expect(refusal(() => requirePostgresTransaction())).toBeInstanceOf(
      IdempotencyError.OutsideTransaction,
    );
  });

  it("the same owner twice: the inner transaction answers", async () => {
    const owner = {};
    const [first, second] = [await clientOf(), await clientOf()];

    await withAmbientTransaction(owner, first, () =>
      withAmbientTransaction(owner, second, () => {
        expect(requiredTransaction(owner)).toBe(second);
        return Promise.resolve();
      }),
    );
  });
});
