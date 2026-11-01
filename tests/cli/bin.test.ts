import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { freshSchema } from "../support/database.js";

const run = promisify(execFile);
const BIN = new URL("../../bin/agboss-postgres.js", import.meta.url).pathname;
const BUILT = new URL("../../dist/cli.js", import.meta.url).pathname;

describe("the agboss-postgres bin (a Kubernetes Job)", () => {
  it("is built: npm test builds first (pretest)", () => {
    expect(existsSync(BUILT)).toBe(true);
  });

  it("migrates, then reports nothing to apply; a usage error exits 2", async () => {
    const url = await freshSchema();

    const first = await run("node", [BIN, "migrate", "--url", url]);
    const second = await run("node", [BIN, "migrate"], {
      env: { ...process.env, DATABASE_URL: url },
    });
    const usage = await run("node", [BIN, "migrate", "--url"]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(first.stdout).toContain("applied 0013_nul_escape");
    expect(second.stdout).toMatch(/nothing to apply: t_\w+ is at migration 19/);
    expect(usage).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("usage: agboss-postgres"),
    });
  });
});
