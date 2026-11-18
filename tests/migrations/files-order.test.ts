import { describe, expect, it, vi } from "vitest";
import { migrationsIn } from "../../src/migrations/files.js";

/**
 * The folder's listing order is the file system's (APFS sorts by name, ext4 by hash): the
 * migrations are ordered by version whatever it is. Here the listing comes back reversed.
 */
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: (folder: string) => fs.readdirSync(folder).reverse() };
});

describe("the package's migration files, listed out of order", () => {
  it("are applied by version, not in the order the folder lists them", () => {
    const versions = migrationsIn().map((file) => file.version);

    expect(versions).toEqual(Array.from({ length: 35 }, (_, index) => index + 1));
  });
});
