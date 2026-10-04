#!/usr/bin/env node
// Standalone bridge: for clients that want a long-running daemon rather than an
// in-process Pi extension (MolaGPT, SillyTavern, any OpenAI-compatible app).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBridgeServer,
  resolveVariant,
  resolveElectronBinary,
  defaultStateDir,
  findManagedCertificate
} from "../src/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stateDir = defaultStateDir();

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

function usage() {
  process.stdout.write(
    [
      "workbuddy-bridge — expose WorkBuddy desktop-app models as an OpenAI-compatible endpoint",
      "",
      "Usage: workbuddy-bridge [options]",
      "",
      "  --variant <cn|ai>       WorkBuddy product to bridge (default: cn)",
      "  --port <n>              HTTP port (default: 8899; 0 picks a free port)",
      "  --https-port <n>        HTTPS port (default: 9443; omit with --no-https)",
      "  --no-https              Serve plain HTTP only",
      "  --pfx <path>            PKCS#12 certificate for HTTPS",
      "  --pfx-pass <pass>       PKCS#12 passphrase",
      "  --prefix <text>         Model id prefix (default: wb/)",
      "  --state-dir <path>      Where to keep this bridge's credential copy",
      "  --electron-bin <path>   WorkBuddy executable (for decrypting the sign-in)",
      "  --doctor                Print diagnostics and exit",
      "  --help, -h              Show this help",
      ""
    ].join("\n")
  );
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const variant = resolveVariant(valueOf("--variant", "cn"));
if (!variant) {
  process.stderr.write(`unknown --variant ${JSON.stringify(valueOf("--variant", "cn"))}; expected cn or ai\n`);
  process.exit(2);
}

const noHttps = hasFlag("--no-https");
const httpPort = Number.parseInt(valueOf("--port", "8899"), 10);
const httpsPort = Number.parseInt(valueOf("--https-port", "9443"), 10);
const pfx = valueOf("--pfx", path.join(HERE, "..", "relay.pfx"));
const pfxPass = valueOf("--pfx-pass", "workbuddy");
const modelPrefix = valueOf("--prefix", process.env.WORKBUDDY_MODEL_PREFIX ?? "wb/");

const log = (message) => process.stdout.write(`[${new Date().toTimeString().slice(0, 8)}] ${message}\n`);

// Resolve the binary once and reuse the verdict, so --doctor and a normal run
// cannot disagree about which installation will be used.
const cliElectronBin = valueOf("--electron-bin", undefined);
const electronResolution = cliElectronBin === undefined
  ? resolveElectronBinary(variant)
  : { path: cliElectronBin, source: "option" };
const electronBin = electronResolution.path;
const invalidEnvVar = variant === "workbuddy-ai" ? "WORKBUDDY_AI_ELECTRON_BIN" : "WORKBUDDY_ELECTRON_BIN";

if (hasFlag("--doctor")) {
  const bridge = createBridgeServer({
    variant,
    stateDir: valueOf("--state-dir", stateDir),
    modelPrefix,
    electronBin,
    logger: () => {}
  });
  const status = await bridge.status();
  const binaryLine = electronBin !== undefined
    ? `${electronBin}  (${electronResolution.source === "option" ? "--electron-bin" : electronResolution.source})`
    : electronResolution.invalidEnv !== undefined
      ? `INVALID — ${invalidEnvVar} names a missing file: ${electronResolution.invalidEnv}`
      : `(not found — set ${invalidEnvVar})`;
  const lines = [
    `variant        : ${variant.id} (${variant.region})`,
    `electron binary: ${binaryLine}`,
    `credential copy: ${bridge.store.ownAuthPath()}`,
    `desktop auth   : ${bridge.store.desktopAuthPath() ?? "(none)"} [${await bridge.store.desktopAuthFormat()}]`,
    `sign-in        : ${status.state}${status.reason ? ` — ${status.reason}` : ""}`,
    ...(status.nickname ? [`nickname       : ${status.nickname}`] : []),
    ...(status.domain ? [`domain         : ${status.domain}`] : [])
  ];
  if (status.state === "signed-in") {
    const models = await bridge.currentModels();
    lines.push(`models         : ${models.length}`);
    for (const model of models) lines.push(`  ${model.id}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  await bridge.close();
  process.exit(status.state === "signed-in" ? 0 : 1);
}

if (!electronBin) {
  if (electronResolution.invalidEnv !== undefined) {
    log(`!! ${invalidEnvVar} names a file that does not exist:`);
    log(`   ${electronResolution.invalidEnv}`);
    log("   Fix or unset it, then restart. Another installation will not be substituted.");
  } else {
    log("!! no WorkBuddy binary found; encrypted credentials cannot be unlocked.");
    log(`   set ${invalidEnvVar} to the app's executable, e.g.`);
    log("   set WORKBUDDY_ELECTRON_BIN=%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe");
  }
}

const bridge = createBridgeServer({
  variant,
  stateDir: valueOf("--state-dir", stateDir),
  modelPrefix,
  electronBin,
  logger: log
});

const status = await bridge.status();
if (status.state === "signed-in") {
  log(`signed in${status.nickname ? ` as ${status.nickname}` : ""} @ ${status.domain ?? "?"}`);
} else {
  log(`!! not signed in: ${status.reason ?? status.reasonCode ?? "unknown"}`);
  log("   sign in once in the WorkBuddy desktop app, then restart this bridge.");
}
log(`credential copy: ${bridge.store.ownAuthPath()}`);

const boundHttp = await bridge.listenHttp(httpPort, "127.0.0.1");
log(`HTTP  http://127.0.0.1:${boundHttp}/v1`);

if (!noHttps) {
  // Prefer the certificate managed by `workbuddy-cert`; fall back to --pfx.
  const managed = findManagedCertificate(valueOf("--state-dir", stateDir));
  if (managed) {
    try {
      const boundHttps = await bridge.listenHttps({
        port: httpsPort,
        key: managed.key,
        cert: managed.cert
      });
      if (boundHttps !== null) log(`HTTPS https://localhost:${boundHttps}/v1`);
    } catch (error) {
      log(`!! HTTPS failed to start: ${error.message}`);
    }
  } else if (fs.existsSync(pfx)) {
    try {
      const boundHttps = await bridge.listenHttps({ port: httpsPort, pfx, passphrase: pfxPass });
      if (boundHttps !== null) log(`HTTPS https://localhost:${boundHttps}/v1`);
    } catch (error) {
      log(`!! HTTPS failed to start: ${error.message}`);
    }
  } else {
    log("note: no certificate configured; HTTPS disabled.");
    log("      run 'workbuddy-cert create && workbuddy-cert trust' to enable it,");
    log("      or pass --pfx <file>, or use --no-https to silence this.");
  }
}

log("ready — press Ctrl+C to stop");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log("shutting down");
    await bridge.close().catch(() => {});
    process.exit(0);
  });
}
