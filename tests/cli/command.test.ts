import { describe, expect, it } from "vitest";
import { ExitCode, runCommand, USAGE, type CommandIo } from "../../src/cli.js";
import { migrationsIn } from "../../src/migrations/files.js";
import { migrateWith } from "../../src/migrations/migrate.js";
import { dropSchema, freshSchema, newSchemaName, serverUrl } from "../support/database.js";
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

    expect(first.lines.slice(0, 30)).toEqual([
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
      expect.stringMatching(/^applied 0021_pause_answers_by_tree/),
      expect.stringMatching(/^applied 0022_cost_ledger_entries/),
      expect.stringMatching(/^applied 0023_cost_entries_pruned/),
      expect.stringMatching(/^applied 0024_pause_kind/),
      expect.stringMatching(/^applied 0025_records_by_run/),
      expect.stringMatching(/^applied 0026_a2a_tasks/),
      expect.stringMatching(/^applied 0027_outbound_call_outcome_names/),
      expect.stringMatching(/^applied 0028_a2a_task_mesh_body_hash/),
      expect.stringMatching(/^applied 0029_execution_lease_token/),
      expect.stringMatching(/^applied 0030_a2a_direct_messages/),
    ]);
    expect(first.lines[30]).toMatch(/^applied \d+ LangGraph checkpoint migration\(s\)$/);
    expect(second.lines).toEqual([
      expect.stringMatching(/^nothing to apply: t_\w+ is at migration 30$/),
    ]);
    expect([...first.errors, ...second.errors]).toEqual([]);
  });

  it("agbossjs/agboss#891: without --url it migrates POSTGRES_URL", async () => {
    const url = await freshSchema();
    const io = ioOf({ POSTGRES_URL: url });

    expect(await runCommand(["migrate"], io)).toBe(ExitCode.Ok);
    expect(io.lines).toHaveLength(31);
  });

  it("agbossjs/agboss#891: DATABASE_URL is still read for one release, when POSTGRES_URL is unset", async () => {
    const url = await freshSchema();
    const io = ioOf({ DATABASE_URL: url });

    expect(await runCommand(["migrate"], io)).toBe(ExitCode.Ok);
    expect(io.lines).toHaveLength(31);
    expect(USAGE).toContain("DATABASE_URL is still read when POSTGRES_URL is unset");
  });

  it("agbossjs/agboss#891: POSTGRES_URL wins over DATABASE_URL, --url over both", async () => {
    const [postgresUrl, url] = [await freshSchema(), await freshSchema()];
    const fromEnv = ioOf({ POSTGRES_URL: postgresUrl, DATABASE_URL: "not a url" });
    const fromFlag = ioOf({ POSTGRES_URL: "not a url", DATABASE_URL: "not a url" });

    expect(await runCommand(["migrate"], fromEnv)).toBe(ExitCode.Ok);
    expect(await runCommand(["migrate", "--url", url], fromFlag)).toBe(ExitCode.Ok);
  });

  it("agbossjs/agboss#891: --schema migrates that schema, created when missing", async () => {
    const schema = newSchemaName();
    const io = ioOf({ POSTGRES_URL: serverUrl() });
    try {
      expect(await runCommand(["migrate", "--schema", schema], io)).toBe(ExitCode.Ok);
      expect(io.lines[0]).toBe(`applied 0001_execution_leases (${schema})`);
    } finally {
      await dropSchema(schema);
    }
  });

  it("agbossjs/agboss#891: --flag=value works as --flag value, for --schema and --url", async () => {
    const [spaced, equals] = [newSchemaName(), newSchemaName()];
    const io = ioOf({ POSTGRES_URL: "not a url" });
    try {
      expect(await runCommand(["migrate", "--schema", spaced, `--url=${serverUrl()}`], io)).toBe(
        ExitCode.Ok,
      );
      expect(await runCommand(["migrate", `--schema=${equals}`, "--url", serverUrl()], io)).toBe(
        ExitCode.Ok,
      );
      expect(io.lines).toContain(`applied 0001_execution_leases (${spaced})`);
      expect(io.lines).toContain(`applied 0001_execution_leases (${equals})`);
      expect(io.errors).toEqual([]);
    } finally {
      await dropSchema(spaced);
      await dropSchema(equals);
    }
  });

  it("agbossjs/agboss#891: an unknown --flag=value names the flag only, never its value", async () => {
    for (const args of [
      ["migrate", "--unknown=s3cret-pw"],
      ["migrate", "--schema=", "--url=postgres://u:s3cret-pw@h/db"],
      ["migrate", "--url=postgres://u:s3cret-pw@h/db", "--url=postgres://u:s3cret-pw@h/db"],
    ]) {
      const io = ioOf();

      expect(await runCommand(args, io)).toBe(ExitCode.Usage);
      expect(io.errors.join("\n")).not.toContain("s3cret-pw");
    }
    const named = ioOf();
    await runCommand(["migrate", "--schema=", "--unknown=x"], named);
    expect(named.errors[0]).toContain("unexpected arguments (flags: --schema <flag>)");
  });

  it("neither --url nor POSTGRES_URL nor DATABASE_URL: a usage error, exit code 2", async () => {
    for (const env of [{}, { POSTGRES_URL: "", DATABASE_URL: "" }]) {
      const io = ioOf(env);
      expect(await runCommand(["migrate"], io)).toBe(ExitCode.Usage);
      expect(io.errors.join("\n")).toContain("no --url and no POSTGRES_URL");
      expect(io.errors.join("\n")).toContain(USAGE);
    }
  });

  it.each([
    [["migrate", "--url"]],
    [["migrate", "--url", ""]],
    [["migrate", "--uri", "postgres://x"]],
    [["migrate", "--url", "postgres://x", "extra"]],
    [["migrate", "--url", "postgres://x", "--url", "postgres://y"]],
    [["migrate", "--schema"]],
    [["migrate", "--schema", ""]],
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
      migrationsIn(migrationsFolder({ "0031_later.sql": "CREATE TABLE later (id integer);" })),
    );
    const io = ioOf();

    expect(await runCommand(["migrate", "--url", url], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toMatch(
      /^agboss-postgres: the migration failed — the PostgreSQL schema is at migration 31/,
    );
  });

  it("a failure that is not an Error is printed too", async () => {
    const io = ioOf();

    expect(await runCommand(["migrate", "--url", "not a url"], io)).toBe(ExitCode.Failed);
    expect(io.errors[0]).toContain("the migration failed");
  });

  it("agbossjs/agboss#891: no output of the command holds a URL's password", async () => {
    const secretUrl = "postgres://app:s3cret-pw@127.0.0.1:1/app";
    const failed = ioOf({ POSTGRES_URL: secretUrl });
    const usage = ioOf();
    const equalsForm = ioOf(); // --url=<url> is a URL now: the run fails at the connection, masked

    expect(await runCommand(["migrate"], failed)).toBe(ExitCode.Failed);
    expect(await runCommand(["migrate", "--url", secretUrl, "extra"], usage)).toBe(ExitCode.Usage);
    expect(await runCommand(["migrate", `--url=${secretUrl}`], equalsForm)).toBe(ExitCode.Failed);

    const shapes = [
      "postgres://u:s3cret-pw@h/db",
      "mongodb+srv://u:s3cret-pw@h",
      "--x=s3cret-pw",
      "-ps3cret-pw",
      "s3cret-pw",
    ];
    const malformed = [
      ...shapes.flatMap((shape) => [
        [shape],
        ["migrate", shape],
        ["migrate", "--schema", "a", shape],
      ]),
      ["migrate", "--url", secretUrl, "--url", secretUrl],
      ["migrate", "--password", "s3cret-pw"],
    ];
    const others = await Promise.all(
      malformed.map(async (args) => {
        const io = ioOf();
        expect(await runCommand(args, io)).toBe(ExitCode.Usage);
        return [...io.lines, ...io.errors];
      }),
    );

    const printed = [
      ...[...failed.lines, ...failed.errors, ...usage.lines, ...usage.errors],
      ...[...equalsForm.lines, ...equalsForm.errors],
      ...others.flat(),
    ].join("\n");
    expect(printed).toContain("the migration failed");
    expect(printed).not.toContain("s3cret-pw");
  });

  it("agbossjs/agboss#891: the remedy names the command that reads POSTGRES_URL, never a URL on the command line", () => {
    expect(USAGE).toContain("prefer the variable");
  });
});
