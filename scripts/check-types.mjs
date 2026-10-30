#!/usr/bin/env node
/**
 * The `check:types` step: `agboss check` (the pinned `@agboss/cli`, `npm run install:packed`) on
 * the process tests' application, which writes `.agboss/types.d.ts` — the flow types its workflows
 * compile against (`tsconfig.processes.json`). Never committed; run before lint and typecheck, as
 * the core's own `check:types`. The check assembles the application only: the database URL its
 * environment names is a placeholder, nothing connects; the mesh peer's key is a throwaway one.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = createRequire(join(ROOT, "package.json")).resolve("@agboss/cli/bin/agboss.js");
execFileSync(
  process.execPath,
  [cli, "check", "--application", "tests/fixtures/process.application.ts", "--env", "process"],
  {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      AGBOSS_PROCESS_DATABASE_URL: "postgres://placeholder@localhost:5432/placeholder",
      AGBOSS_PROCESS_MESH_PEER_KEY: generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    },
  },
);
console.log("check:types: wrote .agboss/types.d.ts");
