#!/usr/bin/env node
// `agboss-postgres migrate --url <url>`: the migrations of @agboss/postgres (src/cli.ts).
import { runCommand } from "../dist/cli.js";

const code = await runCommand(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
