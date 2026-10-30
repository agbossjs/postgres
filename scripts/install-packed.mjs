#!/usr/bin/env node
/**
 * Installs the `@agboss/core` tarball `npm run pack:framework` made (`.packed/manifest.json`)
 * without changing `package.json` or the lockfile: for the install only, the tarball is a
 * devDependency (`--no-package-lock`), then `package.json` is restored — the peer dependency stays
 * the published range, `node_modules` holds the release candidate. Checks the tarball's SHA-256
 * first and the installed version after.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".packed", "manifest.json");
process.env["npm_config_cache"] ??= join(ROOT, ".packed", ".npm-cache");

if (!existsSync(MANIFEST)) {
  console.error(
    "[install-packed] .packed/manifest.json not found: run `npm run pack:framework` first",
  );
  process.exit(1);
}
const { package: packed, sourceCommit } = JSON.parse(readFileSync(MANIFEST, "utf8"));
const tarball = join(ROOT, ".packed", packed.filename);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (sha256 !== packed.sha256) {
  console.error(
    `[install-packed] ${packed.filename} changed since it was packed (sha256 ${sha256})`,
  );
  process.exit(1);
}

const PACKAGE = join(ROOT, "package.json");
const original = readFileSync(PACKAGE, "utf8");
const withTarball = JSON.parse(original);
withTarball.devDependencies = {
  ...withTarball.devDependencies,
  "@agboss/core": `file:.packed/${packed.filename}`,
};
try {
  writeFileSync(PACKAGE, `${JSON.stringify(withTarball, null, 2)}\n`);
  execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    stdio: "inherit",
  });
} finally {
  writeFileSync(PACKAGE, original);
}

const installed = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "@agboss", "core", "package.json"), "utf8"),
);
if (installed.version !== packed.version) {
  console.error(`[install-packed] installed ${installed.version}, expected ${packed.version}`);
  process.exit(1);
}
console.log(`[install-packed] @agboss/core@${installed.version} from ${sourceCommit}`);
