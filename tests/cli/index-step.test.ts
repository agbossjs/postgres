/**
 * #1038: `agboss-postgres migrate` says what it did to the checkpoint index (agbossjs/agboss#962):
 * built it, found it ready, or skipped it because another run holds its build lock.
 */
import pg from "pg";
import { describe, expect, it } from "vitest";
import { ExitCode, runCommand, type CommandIo } from "../../src/cli.js";
import { INDEX_LOCK_KEY } from "../../src/migrations/checkpoint-step-index.js";
import { freshSchema } from "../support/database.js";

const ioOf = (): CommandIo & { readonly lines: string[] } => {
  const lines: string[] = [];
  return { env: {}, lines, out: (line) => lines.push(line), err: (line) => lines.push(line) };
};

describe("agboss-postgres migrate: the checkpoint index line (#1038)", () => {
  it("AC3: the first run says it built the index, the second that it found it ready", async () => {
    const url = await freshSchema();
    const first = ioOf();
    const second = ioOf();

    expect(await runCommand(["migrate", "--url", url], first)).toBe(ExitCode.Ok);
    expect(await runCommand(["migrate", "--url", url], second)).toBe(ExitCode.Ok);

    expect(first.lines.at(-1)).toMatch(/^built index checkpoints_latest_by_step \(t_\w+\)$/);
    expect(second.lines).toEqual([
      expect.stringMatching(/^nothing to apply: t_\w+ is at migration 1$/),
      expect.stringMatching(/^index checkpoints_latest_by_step \(t_\w+\) is ready$/),
    ]);
  });

  it("AC3: a run that does not get the build's lock says it skipped the index, and which run to repeat", async () => {
    const url = await freshSchema();
    const schema = new URL(url).searchParams.get("options")?.replace("-c search_path=", "") ?? "";
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1, hashtext($2))", [INDEX_LOCK_KEY, schema]);
    const skipped = ioOf();
    try {
      expect(await runCommand(["migrate", "--url", url], skipped)).toBe(ExitCode.Ok);
    } finally {
      await holder.end();
    }

    expect(skipped.lines.at(-1)).toMatch(
      /^skipped index checkpoints_latest_by_step \(t_\w+\): another run holds its build lock; run migrate again when it ends$/,
    );
  });
});
