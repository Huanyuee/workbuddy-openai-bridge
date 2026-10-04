/**
 * Pi extension: expose WorkBuddy desktop-app models to Pi.
 *
 * How it works
 *   Pi's `registerProvider` expects an OpenAI-compatible endpoint, but our
 *   upstream needs WorkBuddy-specific wire quirks (forced streaming,
 *   string-form tool_choice, CLI-shaped headers) and its credentials come from
 *   the desktop app's encrypted sign-in. So instead of pointing Pi straight at
 *   a cloud URL, this extension starts the bridge in-process on an ephemeral
 *   loopback port and registers THAT as the provider. No child process, no
 *   fixed port to collide with, and no separate daemon for the user to run.
 *
 * Usage
 *   pi install npm:workbuddy-openai-bridge
 *   # or, for a one-off run:
 *   pi -e node_modules/workbuddy-openai-bridge/extensions/workbuddy.js
 *
 * Requirements
 *   - WorkBuddy (or WorkBuddy AI) desktop app installed and signed in at least
 *     once. The app binary must remain on disk: since 5.6 the tokens are
 *     encrypted at rest and the app is invoked to unlock them.
 */
import {
  createBridgeServer,
  findElectronBinary,
  resolveVariant,
  defaultStateDir,
  VARIANT_IDS
} from "../src/server.js";

/** Progress goes to stderr: stdout carries Pi's RPC/JSON channel. */
const log = (...args) => console.error("[workbuddy]", ...args);

/** Provider id registered with Pi. */
const PROVIDER_ID = "workbuddy";

export default async function workbuddyExtension(pi) {
  const variantName = process.env.WORKBUDDY_VARIANT ?? "cn";
  const variant = resolveVariant(variantName);
  if (!variant) {
    log(`unknown WORKBUDDY_VARIANT ${JSON.stringify(variantName)}; expected cn or ai`);
    return;
  }

  const electronBin = findElectronBinary(variant);
  if (!electronBin) {
    // Not fatal at load time: the user may set WORKBUDDY_ELECTRON_BIN and
    // /reload. Say exactly what to do rather than failing the whole extension.
    log("no WorkBuddy binary found; set WORKBUDDY_ELECTRON_BIN to the app's executable.");
    log("the provider is registered but requests will fail until it resolves.");
  }

  const bridge = createBridgeServer({
    variant,
    // Defaults to the user's home, never DSH's ~/.dsh: sharing that file would
    // put two writers on one refresh token.
    stateDir: defaultStateDir(),
    modelPrefix: process.env.WORKBUDDY_MODEL_PREFIX ?? "wb/",
    logger: log
  });

  // Ephemeral port: nothing to configure, nothing to collide with.
  const port = await bridge.listenHttp(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  log(`bridge listening on ${baseUrl} (${variant.id})`);

  const status = await bridge.status();
  if (status.state === "signed-in") {
    log(`signed in${status.nickname ? ` as ${status.nickname}` : ""} @ ${status.domain ?? "?"}`);
  } else {
    log(`not signed in: ${status.reason ?? status.reasonCode ?? "unknown"}`);
    log("sign in once in the WorkBuddy desktop app, then /reload.");
  }

  // Fetch the roster once so the provider registration carries real models.
  // Pi needs the model list up front; an empty list would register a provider
  // with nothing selectable in it.
  let models = [];
  try {
    models = await bridge.currentModels();
  } catch (error) {
    log(`could not fetch models: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (models.length === 0) {
    log("no models available yet; provider registered with an empty roster.");
  }

  const definitions = models.map((model) => ({
    id: bridge.exposeId(model.id),
    name: `${bridge.exposeId(model.id)}`,
    api: "openai-completions",
    baseUrl,
    provider: PROVIDER_ID,
    reasoning: model.reasoning?.supports === true,
    input: model.supportsImages ? ["text", "image"] : ["text"],
    ...(typeof model.contextWindow === "number" && model.contextWindow > 0
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(typeof model.maxTokens === "number" && model.maxTokens > 0
      ? { maxTokens: model.maxTokens }
      : {}),
    // Pi's calculateCost() dereferences model.cost unconditionally, so this
    // must be present even when the real price is unknown. WorkBuddy bills in
    // its own credits rather than USD, so zeroes are used deliberately: they
    // keep Pi's accounting from inventing a dollar figure. The per-model credit
    // multiplier is available from the bridge's /health and the WorkBuddy app.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // The bridge pins the wire format, so tell Pi not to second-guess it.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens"
    },
    type: "chat"
  }));

  pi.registerProvider(PROVIDER_ID, {
    name: `WorkBuddy${variant === VARIANT_IDS.ai ? " AI" : ""}`,
    baseUrl,
    // The bridge does not authenticate callers; any non-empty key satisfies Pi.
    apiKey: "workbuddy-bridge",
    api: "openai-completions",
    models: definitions
  });

  log(`provider '${PROVIDER_ID}' registered with ${definitions.length} model(s)`);

  // Shut the listener down when Pi unloads the extension.
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", async () => {
      await bridge.close().catch(() => {});
    });
  }
}
