#!/usr/bin/env node
/**
 * Once `@agboss/core` is on the registry: installs the published version the peer dependency
 * names (`--version <x.y.z>`, default the lowest of the range) instead of the packed tarball,
 * without changing `package.json` or the lockfile (a devDependency for the install only).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "package.json");
const original = readFileSync(PACKAGE, "utf8");
const pkg = JSON.parse(original);
const args = process.argv.slice(2);
const at = args.indexOf("--version");
const version =
  at === -1 ? pkg.peerDependencies["@agboss/core"].replace(/^[\^~]/, "") : args[at + 1];

try {
  const withPublished = {
    ...pkg,
    devDependencies: { ...pkg.devDependencies, "@agboss/core": version },
  };
  writeFileSync(PACKAGE, `${JSON.stringify(withPublished, null, 2)}\n`);
  execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} finally {
  writeFileSync(PACKAGE, original);
}
console.log(`[install-published] @agboss/core@${version} from the registry`);
