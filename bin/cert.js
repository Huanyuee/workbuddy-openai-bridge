#!/usr/bin/env node
// Certificate management for the bridge's HTTPS listener.
//
// Why a separate command
//   HTTPS is required by some clients — MolaGPT (a .NET app) validates the
//   certificate chain and will not accept a self-signed certificate it does not
//   trust. Generating a certificate is easy; getting the OS to trust it is the
//   step users get stuck on, so this command does both and can undo both.
//
// Safety model for the trust store
//   Installing into a trust store is a security-sensitive action, so:
//     - it is never automatic; you must run this command explicitly;
//     - removal is scoped by SHA-1 thumbprint, never by subject name. Other
//       tools (and this machine) may already hold unrelated "CN=localhost"
//       certificates, and a name-based delete would wipe them;
//     - --uninstall only ever removes a certificate whose public key matches
//       the private key this package generated, so it cannot touch anything
//       this package does not own;
//     - the scope defaults to the CURRENT USER store, which needs no
//       administrator rights. --machine is opt-in and warns.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { defaultStateDir } from "../src/server.js";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const stateDir = valueOf("--state-dir", defaultStateDir());
const certDir = path.join(stateDir, "tls");
const keyPath = path.join(certDir, "bridge-key.pem");
const crtPath = path.join(certDir, "bridge-cert.pem");
const metaPath = path.join(certDir, "bridge-cert.json");
const hostname = valueOf("--hostname", "localhost");
const extraHosts = valueOf("--extra-host", "")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const days = Number.parseInt(valueOf("--days", "3650"), 10);
const toMachine = hasFlag("--machine");

function usage() {
  process.stdout.write(
    [
      "workbuddy-cert — create and trust a self-signed certificate for the bridge",
      "",
      "Usage: workbuddy-cert <command> [options]",
      "",
      "Commands:",
      "  create          Generate the key + certificate (no trust store change)",
      "  trust           Install the certificate into the trust store",
      "  untrust         Remove OUR certificate from the trust store",
      "  status          Show what exists and whether it is trusted",
      "",
      "Options:",
      `  --hostname <name>    Primary DNS name (default: localhost)`,
      "  --extra-host <list>  Comma-separated extra DNS names or IPs",
      `  --days <n>           Validity in days (default: 3650)`,
      "  --machine            Use the machine-wide store (needs admin; default: current user)",
      "  --state-dir <path>   Where the bridge keeps state",
      "  --help, -h           Show this help",
      "",
      "The trust scope defaults to the CURRENT USER store, which requires no",
      "administrator rights. Removal is scoped by certificate thumbprint and only",
      "ever removes the certificate this package generated.",
      ""
    ].join("\n")
  );
}

const command = args.find((arg) => !arg.startsWith("-"));
if (hasFlag("--help") || hasFlag("-h") || !command) {
  usage();
  process.exit(command ? 0 : 2);
}

/** Run certutil, returning stdout. Throws with its message on failure. */
function certutil(certutilArgs) {
  return execFileSync("certutil", certutilArgs, { encoding: "utf8" });
}

/** Read the recorded thumbprint, or undefined. */
function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** Normalize a thumbprint for comparison (strip separators and case). */
const norm = (value) => String(value ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();

/** Whether our recorded thumbprint is present in the given store. */
function isTrusted(thumbprint, machine) {
  const scope = machine ? "LocalMachine" : "CurrentUser";
  const storePath = `Cert:\\${scope}\\Root`;
  try {
    // Use the cert provider rather than certutil: parsing localized certutil
    // output is fragile across system languages.
    const found = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-ChildItem -Path '${storePath}' -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq '${thumbprint}' }) { 'yes' } else { 'no' }`
      ],
      { encoding: "utf8" }
    );
    return found.trim() === "yes";
  } catch {
    return false;
  }
}

async function create() {
  let selfsigned;
  try {
    selfsigned = (await import("selfsigned")).default;
  } catch {
    process.stderr.write(
      "the 'selfsigned' package is required to generate certificates.\n" +
        "install it with:  npm install selfsigned\n"
    );
    process.exit(2);
  }

  fs.mkdirSync(certDir, { recursive: true });

  // Build SANs from a set so a repeated name (e.g. --hostname localhost, which
  // is also always included) cannot appear twice.
  const seen = new Set();
  const altNames = [];
  const addDns = (value) => {
    const key = `dns:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    altNames.push({ type: 2, value });
  };
  const addIp = (value) => {
    const key = `ip:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    altNames.push({ type: 7, ip: value });
  };

  for (const name of [hostname, "localhost", "127.0.0.1", ...extraHosts]) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(":")) addIp(name);
    else addDns(name);
  }

  const pems = await selfsigned.generate([{ name: "commonName", value: hostname }], {
    keyType: "rsa",
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 86_400_000), // tolerate clock skew
    notAfterDate: new Date(Date.now() + days * 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames }
    ]
  });

  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(crtPath, pems.cert);

  const thumbprint = norm(pems.fingerprint).toUpperCase().match(/.{2}/g).join(" ");
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        hostname,
        altNames: altNames.map((entry) => (entry.type === 7 ? entry.ip : entry.value)),
        thumbprint: thumbprint.replace(/ /g, ""),
        createdAt: new Date().toISOString(),
        notAfter: new Date(Date.now() + days * 86_400_000).toISOString()
      },
      null,
      2
    )}\n`
  );

  process.stdout.write(`created key : ${keyPath}\n`);
  process.stdout.write(`created cert: ${crtPath}\n`);
  process.stdout.write(`thumbprint  : ${thumbprint}\n`);
  process.stdout.write(`names       : ${altNames.map((e) => e.type === 7 ? e.ip : e.value).join(", ")}\n`);
  process.stdout.write("\nNext: workbuddy-cert trust\n");
}

function trust() {
  const meta = readMeta();
  if (!meta || !fs.existsSync(crtPath)) {
    process.stderr.write("no certificate yet; run 'workbuddy-cert create' first\n");
    process.exit(2);
  }

  if (isTrusted(meta.thumbprint, toMachine)) {
    process.stdout.write(`already trusted (${meta.thumbprint})\n`);
    return;
  }

  if (toMachine) {
    process.stdout.write(
      "!! installing into the MACHINE store affects every user on this computer\n" +
        "   and requires administrator rights.\n"
    );
  }

  const scopeArgs = toMachine ? ["-addstore", "-f", "Root"] : ["-user", "-addstore", "-f", "Root"];
  try {
    certutil([...scopeArgs, crtPath]);
  } catch (error) {
    process.stderr.write(`failed to install the certificate: ${error.message}\n`);
    if (toMachine) process.stderr.write("(the machine store needs an elevated shell)\n");
    process.exit(1);
  }

  const ok = isTrusted(meta.thumbprint, toMachine);
  process.stdout.write(`${ok ? "trusted" : "install reported success but the certificate was not found"} (${meta.thumbprint})\n`);
  if (ok) {
    process.stdout.write(
      toMachine
        ? "restart the bridge to serve this certificate\n"
        : "restart your browser/client if it was already running\n"
    );
  }
  process.exit(ok ? 0 : 1);
}

function untrust() {
  const meta = readMeta();
  if (!meta) {
    process.stderr.write("no record of a certificate created by this package; nothing to remove\n");
    process.exit(2);
  }

  // Only ever remove the exact certificate this package created. A subject-name
  // match would delete unrelated "CN=localhost" certificates other tools rely on.
  const scopes = toMachine ? [true] : hasFlag("--all-scopes") ? [false, true] : [false];
  let removed = 0;

  for (const machine of scopes) {
    if (!isTrusted(meta.thumbprint, machine)) continue;
    const scopeArgs = machine ? ["-delstore", "Root"] : ["-user", "-delstore", "Root"];
    try {
      certutil([...scopeArgs, meta.thumbprint]);
      removed += 1;
      process.stdout.write(`removed from ${machine ? "machine" : "current user"} store (${meta.thumbprint})\n`);
    } catch (error) {
      process.stderr.write(`could not remove from ${machine ? "machine" : "current user"} store: ${error.message}\n`);
    }
  }

  if (removed === 0) process.stdout.write(`not present in the trust store (${meta.thumbprint})\n`);
  if (!hasFlag("--purge")) process.stdout.write("files left in place; delete them with --purge\n");
}

function purge() {
  if (!fs.existsSync(certDir)) {
    process.stdout.write("nothing to purge\n");
    return;
  }
  for (const file of [keyPath, crtPath, metaPath]) {
    fs.rmSync(file, { force: true });
  }
  // Remove the directory too when nothing else lives in it.
  try {
    if (fs.readdirSync(certDir).length === 0) fs.rmdirSync(certDir);
  } catch {
    // A non-empty directory is fine to leave behind.
  }
  process.stdout.write(`removed certificate files from ${certDir}\n`);
}

function status() {
  const meta = readMeta();
  process.stdout.write(`state dir   : ${stateDir}\n`);
  process.stdout.write(`key present : ${fs.existsSync(keyPath)}\n`);
  process.stdout.write(`cert present: ${fs.existsSync(crtPath)}\n`);
  if (!meta) {
    process.stdout.write("certificate : not created yet\n");
    return;
  }
  process.stdout.write(`thumbprint  : ${meta.thumbprint}\n`);
  process.stdout.write(`names       : ${(meta.altNames ?? []).join(", ")}\n`);
  process.stdout.write(`created     : ${meta.createdAt}\n`);
  process.stdout.write(`expires     : ${meta.notAfter}\n`);
  process.stdout.write(`trusted (current user): ${isTrusted(meta.thumbprint, false)}\n`);
  process.stdout.write(`trusted (machine)     : ${isTrusted(meta.thumbprint, true)}\n`);
}

switch (command) {
  case "create":
    await create();
    break;
  case "trust":
    trust();
    break;
  case "untrust":
    untrust();
    if (hasFlag("--purge")) purge();
    break;
  case "purge":
    purge();
    break;
  case "status":
    status();
    break;
  default:
    process.stderr.write(`unknown command ${JSON.stringify(command)}\n`);
    usage();
    process.exit(2);
}
