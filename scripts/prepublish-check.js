#!/usr/bin/env node
// Pre-flight checks for `npm publish`, run before the irreversible step.
//
// Publishing cannot be undone in practice (npm forbids re-using a version
// number), so this prints the things that are easy to overlook and refuses to
// pass when one of them is wrong. Run it, then `npm publish`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const checks = [];
const add = (ok, label, detail) => checks.push({ ok, label, detail });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// --- manifest ---------------------------------------------------------------
add(!pkg.private, "package.json is not private", pkg.private ? "private:true blocks publishing" : "");
add(Boolean(pkg.name && pkg.version), "name and version are set", `${pkg.name}@${pkg.version}`);
add(Boolean(pkg.license), "license is declared", pkg.license ?? "missing");
add(Boolean(pkg.repository?.url), "repository is declared", pkg.repository?.url ?? "missing");
add(Boolean(pkg.description), "description is set", "");
add(
  typeof pkg.engines?.node === "string",
  "engines.node is declared",
  pkg.engines?.node ?? "missing"
);
add(
  Array.isArray(pkg.files) && pkg.files.length > 0,
  "files allowlist is set",
  (pkg.files ?? []).join(", ")
);

// --- entry points -----------------------------------------------------------
for (const [name, target] of Object.entries(pkg.bin ?? {})) {
  const file = path.join(ROOT, target);
  const exists = fs.existsSync(file);
  add(exists, `bin ${name} exists`, target);
  if (exists) {
    const head = fs.readFileSync(file, "utf8").slice(0, 40);
    // npm generates the .cmd/.ps1 shims from this line; without it the command
    // is not runnable after a global install.
    add(head.startsWith("#!/usr/bin/env node"), `bin ${name} has a shebang`, head.split("\n")[0]);
  }
}

for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== "string" || !target.startsWith(".")) continue;
  add(fs.existsSync(path.join(ROOT, target)), `exports "${sub}" exists`, target);
}

// --- hygiene ----------------------------------------------------------------
// On Windows `npm` is npm.cmd, which spawnSync cannot execute without a shell.
// Use the shell so the check behaves the same on every platform.
const runNpm = (args) =>
  execFileSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "ignore"]
  });

// A tarball that carries a credential copy or TLS key would leak them.
const FORBIDDEN = [".state", "tls", ".git", "node_modules", "relay.pfx", ".workbuddy-auth.json"];
let packed = [];
try {
  packed = JSON.parse(runNpm(["pack", "--dry-run", "--json"]))[0].files.map((entry) => entry.path);
} catch (error) {
  add(false, "npm pack --dry-run succeeds", String(error.message).slice(0, 120));
}
if (packed.length > 0) {
  add(true, "tarball contents readable", `${packed.length} file(s)`);
  const leaked = packed.filter((file) =>
    FORBIDDEN.some((bad) => file === bad || file.startsWith(`${bad}/`))
  );
  add(leaked.length === 0, "tarball carries no state/secret paths", leaked.join(", ") || "none");
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    add(packed.includes(required), `tarball includes ${required}`, "");
  }
}

// --- registry ---------------------------------------------------------------
let published = null;
try {
  published = runNpm(["view", `${pkg.name}@${pkg.version}`, "version"]).trim();
} catch {
  published = null; // a 404 here is the good case
}
add(published === null, `version ${pkg.version} is not already published`, published ?? "available");

let whoami = null;
try {
  whoami = runNpm(["whoami"]).trim();
} catch {
  whoami = null;
}
add(whoami !== null, "logged in to npm", whoami ?? "run: npm login");

// --- report -----------------------------------------------------------------
const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  const mark = check.ok ? "ok  " : "FAIL";
  process.stdout.write(`${mark}  ${check.label}${check.detail ? `  — ${check.detail}` : ""}\n`);
}

// A missing login is expected before the first release, and `npm publish
// --dry-run` must stay usable without it. Everything else is a hard stop.
const blocking = failed.filter((check) => check.label !== "logged in to npm");
process.stdout.write("\n");
if (failed.length > 0) {
  const blockingText =
    blocking.length > 0 ? `${blocking.length} blocking check(s) failed.` : "no blocking checks failed.";
  process.stdout.write(`${blockingText}\n`);
  if (whoami === null) process.stdout.write("Not logged in to npm — run `npm login` before the real publish.\n");
  process.exit(blocking.length > 0 ? 1 : 0);
}
process.stdout.write("All checks passed. Next:\n");
process.stdout.write("  npm publish --dry-run    # inspect the final tarball\n");
process.stdout.write("  npm publish              # publish\n");
process.stdout.write("  git push --follow-tags   # push the tag\n");
