import { describe, expect, it } from "vitest";
import { ExitCode, runCommand, USAGE, type CommandIo } from "../../src/cli.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { freshSchema } from "../support/database.js";
import { migrationsFolder } from "../support/migration-folders.js";

/** A command's io: the environment given, its lines kept. */
function ioOf(
  env: CommandIo["env"] = {},
): CommandIo & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { env, lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

describe("agboss-postgres migrate", () => {
  it("--url: the first run lists every migration applied, the second none (M1)", async () => {
    const url = await freshSchema();
    const first = ioOf();
    const second = ioOf();

    expect(await runCommand(["migrate", "--url", url], first)).toBe(ExitCode.Ok);
    expect(await runCommand(["migrate", "--url", url], second)).toBe(ExitCode.Ok);

    expect(first.lines.slice(0, 20)).toEqual([
      expect.stringMatching(/^applied 0001_execution_leases \(t_/),
      expect.stringMatching(/^applied 0002_execution_records/),
      expect.stringMatching(/^applied 0003_execution_trees/),
      expect.stringMatching(/^applied 0004_paused_executions/),
      expect.stringMatching(/^applied 0005_child_execution_queue/),
      expect.stringMatching(/^applied 0006_fenced_effects/),
      expect.stringMatching(/^applied 0007_execution_lease_events/),
      expect.stringMatching(/^applied 0008_execution_lease_yield/),
      expect.stringMatching(/^applied 0009_cost_ledger/),
      expect.stringMatching(/^applied 0010_execution_history/),
      expect.stringMatching(/^applied 0011_rate_limits/),
      expect.stringMatching(/^applied 0012_mesh_requests/),
      expect.stringMatching(/^applied 0013_nul_escape/),
      expect.stringMatching(/^applied 0014_execution_lease_superseded/),
      expect.stringMatching(/^applied 0015_fenced_effect_business_keys/),
      expect.stringMatching(/^applied 0016_outbound_calls/),
      expect.stringMatching(/^applied 0017_execution_lease_finished/),
      expect.stringMatching(/^applied 0018_execution_ids/),
      expect.stringMatching(/^applied 0019_execution_ids_from_outbound_calls/),
      expect.stringMatching(/^applied 0020_pauses_by_tree/),
    ]);
    expect(first.lines[20]).toMatch(/^applied \d+ LangGraph checkpoint migration\(s\)$/);
    expect(second.lines).toEqual([
      expect.stringMatching(/^nothing to apply: t_\w+ is at migration 20$/),
    ]);
    expect([...first.errors, ...second.errors]).toEqual([]);
  });

  it("without --url it migrates DATABASE_URL", async () => {
    const url = await freshSchema();
    const io = ioOf({ DATABASE_URL: url });

    expect(await runCommand(["migrate"], io)).toBe(ExitCode.Ok);
    expect(io.lines).toHaveLength(21);
  });

  it("neither --url nor DATABASE_URL: a usage error, exit code 2", async () => {
    for (const env of [{}, { DATABASE_URL: "" }]) {
      const io = ioOf(env);
      expect(await runCommand(["migrate"], io)).toBe(ExitCode.Usage);
      expect(io.errors.join("\n")).toContain("no --url and no DATABASE_URL");
      expect(io.errors.join("\n")).toContain(USAGE);
    }
  });

  it.each([
    [["migrate", "--url"]],
    [["migrate", "--url", ""]],
    [["migrate", "--uri", "postgres://x"]],
    [["migrate", "--url", "postgres://x", "extra"]],
  ])("wrong arguments %j: a usage error", async (args) => {
    const io = ioOf();

    expect(await runCommand(args, io)).toBe(ExitCode.Usage);
    expect(io.errors[0]).toContain("unexpected arguments");
  });

  it("an unknown command, or none: a usage error", async () => {
    for (const args of [["upgrade"], []]) {
      const io = ioOf();
      expect(await runCommand(args, io)).toBe(ExitCode.Usage);
      expect(io.errors[0]).toContain("unknown command");
    }
  });

  it("--help prints the usage", async () => {
    for (const flag of ["--help", "-h"]) {
      const io = ioOf();
      expect(await runCommand([flag], io)).toBe(ExitCode.Ok);
      expect(io.lines).toEqual([USAGE]);
    }
  });

  it("a failed run: exit code 1 and why", async () => {
    const url = await freshSchema();
    await migrateWith(
      { url },
      migrationsIn(migrationsFolder({ "0021_later.sql": "CREATE TABLE later (id integer);" })),
    );
    const io = ioOf();

    expect(await runCommand(["migrate", "--url", url], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toMatch(
      /^agboss-postgres: the migration failed — the PostgreSQL schema is at migration 21/,
    );
  });

  it("a failure that is not an Error is printed too", async () => {
    const io = ioOf();

    expect(await runCommand(["migrate", "--url", "not a url"], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toContain("the migration failed");
  });
});
