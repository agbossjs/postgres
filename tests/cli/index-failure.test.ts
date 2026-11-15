/**
 * #1102: when the checkpoint index step fails (a cancelled build, a role that does not own
 * `checkpoints`), the migrations the run committed are listed, the failing step is named with its
 * cause, no INVALID index stays behind, the exit code is 1, and the thrown error says "index not
 * built", not "schema not migrated".
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { ExitCode, runCommand, type CommandIo } from "../../src/cli.js";
import { migratePostgres, PostgresStepIndexError } from "../../src/index.js";
import { STEP_INDEX_NAME } from "../../src/migrations/checkpoint-step-index.js";
import { createSchema, dropSchema, onSchema, onServer, serverUrl } from "../support/database.js";

const ioOf = (): CommandIo & { readonly out_: string[]; readonly err_: string[] } => {
  const out_: string[] = [];
  const err_: string[] = [];
  return { env: {}, out_, err_, out: (line) => out_.push(line), err: (line) => err_.push(line) };
};

const schemas: string[] = [];
const roles: string[] = [];
const holders: pg.Client[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.end().catch(() => undefined);
  for (const schema of schemas.splice(0)) await dropSchema(schema);
  for (const role of roles.splice(0))
    await onServer(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
});

async function fresh(): Promise<{ readonly schema: string; readonly url: string }> {
  const made = await createSchema();
  schemas.push(made.schema);
  return made;
}

/** The index's `indisvalid`; undefined when there is no index. */
async function validityOf(url: string): Promise<boolean | undefined> {
  const { rows } = await onSchema(
    url,
    `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
    [STEP_INDEX_NAME],
  );
  return rows[0] === undefined ? undefined : (rows[0] as { valid: boolean }).valid;
}

const appliedCount = async (url: string): Promise<number> =>
  Number(
    (await onSchema(url, "SELECT count(*)::int AS n FROM agboss_schema_migrations")).rows[0]?.n,
  );

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 600; waited += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("not within the time");
}

/** Holds an old snapshot open (a `CREATE INDEX CONCURRENTLY` waits for it) until the client ends. */
async function holdSnapshot(url: string): Promise<void> {
  const holder = new pg.Client({ connectionString: url });
  holder.on("error", () => undefined);
  holders.push(holder);
  await holder.connect();
  await holder.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await holder.query("SELECT count(*) FROM pg_class");
}

/** Cancels the statement of the build once it waits. */
async function cancelBuild(schema: string): Promise<void> {
  const canceller = new pg.Client({ connectionString: serverUrl() });
  await canceller.connect();
  try {
    await until(async () => {
      const { rows } = await canceller.query(
        `SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
          WHERE query LIKE 'CREATE INDEX CONCURRENTLY%' AND query LIKE $1 AND pid <> pg_backend_pid()`,
        [`%${schema}%`],
      );
      return rows.length > 0;
    });
  } finally {
    await canceller.end();
  }
}

/** A role that may use and write the schema's tables but owns none of them. */
async function nonOwnerUrl(schema: string): Promise<string> {
  const role = `r_${randomBytes(5).toString("hex")}`;
  roles.push(role);
  await onServer(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
  const database = new URL(serverUrl()).pathname.slice(1);
  await onServer(`GRANT CONNECT, CREATE ON DATABASE "${database}" TO ${role}`);
  await onServer(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
  await onServer(
    `GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${role}; GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
  );
  const url = new URL(serverUrl());
  url.username = role;
  url.password = "pw";
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe("#1102: the index step fails after the migrations committed", () => {
  it("AC1: a cancelled build: the applied lines, the index step named with its cause, exit 1, no INVALID index", async () => {
    const { schema, url } = await fresh();
    await holdSnapshot(url);
    const io = ioOf();

    const [code] = await Promise.all([
      runCommand(["migrate", "--url", url], io),
      cancelBuild(schema),
    ]);

    expect(code).toBe(ExitCode.Failed);
    expect(io.out_.filter((line) => line.startsWith("applied "))).toHaveLength(32);
    expect(io.out_.at(0)).toMatch(new RegExp(`^applied 0001_\\w+ \\(${schema}\\)$`));
    expect(io.out_.at(-1)).toMatch(/^applied \d+ LangGraph checkpoint migration\(s\)$/);
    expect(io.err_).toHaveLength(1);
    expect(io.err_[0]).toMatch(
      new RegExp(
        `^index checkpoints_latest_by_step \\(${schema}\\) failed: canceling statement due to user request; .*next migrate run rebuilds the index`,
      ),
    );
    expect(io.err_[0]).not.toContain("the migration failed");
    // the migrations are committed, and the failed build left no INVALID index
    expect(await appliedCount(url)).toBe(31);
    expect(await validityOf(url)).toBeUndefined();
  });

  it("AC2: the thrown error is a PostgresStepIndexError carrying what the run applied; the next run builds the index", async () => {
    const { schema, url } = await fresh();
    await holdSnapshot(url);

    const [failure] = await Promise.all([
      migratePostgres({ url }).then(
        () => undefined,
        (error: unknown) => error,
      ),
      cancelBuild(schema),
    ]);

    expect(failure).toBeInstanceOf(PostgresStepIndexError);
    const error = failure as PostgresStepIndexError;
    expect(error.code).toBe("postgres.step-index-failed");
    expect(error.report.schema).toBe(schema);
    expect(error.report.applied).toHaveLength(31);
    expect(error.report.version).toBe(31);
    for (const holder of holders.splice(0)) await holder.end();

    const next = await migratePostgres({ url });
    expect(next.applied).toEqual([]);
    expect(next.stepIndex).toBe("built");
    expect(await validityOf(url)).toBe(true);
  });

  it("AC1: a role that does not own checkpoints: nothing to apply, the index step failed with the owner error, exit 1", async () => {
    const { schema, url } = await fresh();
    await migratePostgres({ url });
    await onSchema(url, `DROP INDEX ${STEP_INDEX_NAME}`);
    const roleUrl = await nonOwnerUrl(schema);
    const io = ioOf();

    expect(await runCommand(["migrate", "--url", roleUrl], io)).toBe(ExitCode.Failed);

    expect(io.out_).toEqual([`nothing to apply: ${schema} is at migration 31`]);
    expect(io.err_).toHaveLength(1);
    expect(io.err_[0]).toMatch(
      new RegExp(
        `^index checkpoints_latest_by_step \\(${schema}\\) failed: must be owner of table checkpoints; `,
      ),
    );
    expect(await validityOf(url)).toBeUndefined();
  });

  it("AC1: a failure that is not the index step is still 'the migration failed', with no applied lines", async () => {
    const io = ioOf();

    const code = await runCommand(
      ["migrate", "--url", "postgres://nobody:pw@127.0.0.1:1/none"],
      io,
    );

    expect(code).toBe(ExitCode.Failed);
    expect(io.out_).toEqual([]);
    expect(io.err_[0]).toMatch(/^agboss-postgres: the migration failed — /);
  });
});
