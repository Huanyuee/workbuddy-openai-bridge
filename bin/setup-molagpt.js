#!/usr/bin/env node
// Write the bridge's models straight into MolaGPT's provider record.
//
// Why this is needed
//   MolaGPT's "auto-detect" dialog filters model ids through a hard-coded
//   vendor token list (LooksLikeChatModel), so a WorkBuddy roster of ~19 models
//   surfaces as only the two "deepseek-*" ones. Writing the records directly
//   bypasses that filter. The filter only affects the detection dialog, not
//   model invocation.
//
// Safety
//   - Backs the database up before any write.
//   - Dry-run by default; pass --apply to commit.
//   - Refuses to run while MolaGPT is open (it would overwrite this on exit).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBridgeServer, resolveVariant, defaultStateDir } from "../src/server.js";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const apply = hasFlag("--apply");
const prefix = valueOf("--prefix", "wb/");
const baseUrl = valueOf("--url", "https://localhost:9443/");
const dbPath = valueOf("--db", path.join(process.env.LOCALAPPDATA ?? "", "MolaGPT", "molagpt.db"));
const backupDir = valueOf("--backup-dir", path.join(os.homedir(), "MolaGPT-backup"));
const variant = resolveVariant(valueOf("--variant", "cn"));

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(
    [
      "workbuddy-setup-molagpt — add WorkBuddy bridge models to MolaGPT",
      "",
      "Usage: workbuddy-setup-molagpt [--apply] [options]",
      "",
      "  --apply              Actually write (otherwise dry-run)",
      "  --url <base>         Provider base URL (default: https://localhost:9443/)",
      "  --prefix <text>      Model id prefix (default: wb/)",
      "  --db <path>          MolaGPT database (default: %LOCALAPPDATA%\\MolaGPT\\molagpt.db)",
      "  --backup-dir <path>  Where to write the backup",
      "  --variant <cn|ai>    WorkBuddy product (default: cn)",
      "  --help, -h           Show this help",
      ""
    ].join("\n")
  );
  process.exit(0);
}

if (!fs.existsSync(dbPath)) {
  process.stderr.write(`database not found: ${dbPath}\n`);
  process.exit(2);
}

// Refuse to write while MolaGPT is running: the live instance holds the model
// list in memory and can overwrite this change when the provider is saved.
const molaRunning =
  process.platform === "win32" &&
  (() => {
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq MolaGPT.Desktop.exe", "/NH"], {
        encoding: "utf8"
      });
      return out.toLowerCase().includes("molagpt.desktop.exe");
    } catch {
      return false;
    }
  })();

if (molaRunning && apply) {
  process.stderr.write(
    "MolaGPT is running. Quit it completely first, then re-run with --apply.\n" +
      "A running instance can overwrite this change when the provider is saved.\n"
  );
  process.exit(3);
}

// node:sqlite ships with Node 22.5+; avoid a native dependency.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  process.stderr.write("this script needs Node.js 22.5+ (for node:sqlite)\n");
  process.exit(2);
}

const bridge = createBridgeServer({
  variant,
  stateDir: valueOf("--state-dir", defaultStateDir()),
  modelPrefix: prefix,
  logger: () => {}
});

const status = await bridge.status();
if (status.state !== "signed-in") {
  process.stderr.write(
    `not signed in to WorkBuddy: ${status.reason ?? status.reasonCode ?? "unknown"}\n` +
      "Sign in once in the WorkBuddy desktop app, then re-run.\n"
  );
  process.exit(1);
}

const models = await bridge.currentModels();
await bridge.close();

if (models.length === 0) {
  process.stderr.write("no models returned by the bridge; nothing to write\n");
  process.exit(1);
}

/**
 * Build one MolaGPT model record.
 *
 * Field vocabulary is copied from a record MolaGPT itself produced for an
 * OpenAI-compatible provider. Notably `ThinkingParamKind` is left null: null is
 * what MolaGPT writes for its own DeepSeek record, so it is a proven-valid
 * value, whereas its managed-model enum values are not verifiable here.
 */
function toRecord(model) {
  const reasoning = model.reasoning ?? {};
  const efforts = reasoning.supportedEfforts ?? null;
  return {
    Id: `${prefix}${model.id}`,
    DisplayName: `${prefix}${model.id}`,
    Vision: model.supportsImages === true,
    ContextWindow: null,
    Thinking: reasoning.supports === true,
    ReasoningEffort: Boolean(efforts?.length || reasoning.defaultEffort),
    Tools: true,
    ThinkingParamKind: null,
    ThinkingBudgetMin: null,
    ThinkingBudgetMax: null,
    ThinkingBudgetDefault: null,
    DefaultEffort: reasoning.defaultEffort ?? null,
    ImageEdit: false,
    CustomBody: null,
    EffortLevels: efforts,
    ReasoningMandatory: reasoning.onlyReasoning === true,
    SupportsTemperature: true,
    SupportsTopP: true,
    Pricing: null
  };
}

const records = models.map(toRecord);

const db = new DatabaseSync(dbPath);
const rows = db
  .prepare("SELECT id, name, base_url, models FROM providers WHERE base_url LIKE ?")
  .all(`%${new URL(baseUrl).port || ""}%`);

if (rows.length !== 1) {
  process.stderr.write(
    `expected exactly 1 provider whose base_url matches ${baseUrl}, found ${rows.length}\n`
  );
  for (const row of rows) process.stderr.write(`  ${row.id}  ${row.name}  ${row.base_url}\n`);
  if (rows.length === 0) {
    process.stderr.write("\nAdd the provider in MolaGPT first:\n");
    process.stderr.write(`  address ${baseUrl}  (type: OpenAI-compatible, any API key)\n`);
  }
  db.close();
  process.exit(2);
}

const row = rows[0];
const existing = JSON.parse(row.models);
process.stdout.write(`provider : ${row.id}  (${row.base_url})\n`);
process.stdout.write(`existing : ${existing.length} model(s)\n`);
process.stdout.write(`writing  : ${records.length} model(s)\n\n`);

if (!apply) {
  process.stdout.write("--- DRY RUN (pass --apply to write) ---\n");
  process.stdout.write(`${JSON.stringify(records[0], null, 1)}\n\n`);
  for (const record of records) process.stdout.write(`  ${record.Id}\n`);
  db.close();
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `molagpt-${stamp}.db`);
fs.copyFileSync(dbPath, backupPath);
process.stdout.write(`backup   : ${backupPath}\n`);

db.prepare("UPDATE providers SET models = ? WHERE id = ?").run(
  JSON.stringify(records),
  row.id
);

const check = JSON.parse(
  db.prepare("SELECT models FROM providers WHERE id = ?").get(row.id).models
);
process.stdout.write(`written  : ${check.length} model(s)\n`);
for (const record of check) process.stdout.write(`  ${record.Id}\n`);
db.close();

process.stdout.write("\nNow fully quit and restart MolaGPT.\n");
process.stdout.write("Do NOT open that provider's settings page and save before restarting.\n");
