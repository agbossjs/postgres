/**
 * AC3 (agbossjs/agboss#483): the execution history is one in PostgreSQL. Executions run on A and
 * on B — two tenants, one of them resting at a pause — and `agboss records export --all-tenants`,
 * run as one more process with B's environment (as `kubectl exec` into pod B would), lists every
 * one of them, oldest start first, each with the instance that ran it; `--tenant` lists only that
 * tenant's, from either process's runs.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { launch, processEnvOf } from "./instances.js";

const database = testDatabase();

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = createRequire(join(ROOT, "package.json")).resolve("@agboss/cli/bin/agboss.js");

/** One exported line: what the test reads of it. */
interface Exported {
  readonly kind: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly application: { readonly instanceId: string };
}

/** `agboss records export <whose…>` on the test's schema: the lines it wrote. */
async function exportRecords(whose: readonly string[]): Promise<Exported[]> {
  const out = join(mkdtempSync(join(tmpdir(), "agboss-export-")), "records.jsonl");
  const application = ["--application", "tests/fixtures/process.application.ts"];
  await promisify(execFile)(
    process.execPath,
    [CLI, "records", "export", ...whose, "--out", out, ...application, "--env", "process"],
    { cwd: ROOT, env: processEnvOf(database.url()) },
  );
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Exported);
}

interface Output {
  readonly status: string;
  readonly executionId: string;
}

describe("AC3: the history export across two processes", () => {
  it("AC3: agboss records export from process B returns executions run on every pod", async () => {
    const a = await launch(database.url());
    const b = await launch(database.url());

    const onA = (await a.send("execute", {
      workflow: "limited",
      input: { name: "on-a" },
      tenantId: "acme",
    })) as Output;
    const onB = (await b.send("execute", {
      workflow: "limited",
      input: { name: "on-b" },
      tenantId: "globex",
    })) as Output;
    const paused = (await a.send("execute", {
      workflow: "approval",
      input: { name: "paused-on-a" },
      tenantId: "acme",
    })) as Output;

    const all = await exportRecords(["--all-tenants"]);
    const acme = await exportRecords(["--tenant", "acme"]);

    expect(paused.status).toBe("paused");
    expect(all).toEqual([
      expect.objectContaining({
        kind: "agboss.execution-record",
        executionId: onA.executionId,
        tenantId: "acme",
        status: "finished",
        application: expect.objectContaining({ instanceId: a.instanceId }),
      }),
      expect.objectContaining({
        executionId: onB.executionId,
        tenantId: "globex",
        status: "finished",
        application: expect.objectContaining({ instanceId: b.instanceId }),
      }),
      expect.objectContaining({ executionId: paused.executionId, status: "paused" }),
    ]);
    expect(acme.map((record) => record.executionId)).toEqual([onA.executionId, paused.executionId]);
  }, 120_000);
});
