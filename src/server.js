// The bridge core, exposed as a factory so it can run three ways:
//   - standalone CLI            (bin/bridge.js)
//   - inside a Pi extension     (extensions/workbuddy.js, in-process)
//   - inside any other tool     (import { createBridgeServer })
//
// Design notes
//   - Credentials come from the WorkBuddy desktop app's sign-in. Since
//     WorkBuddy 5.6 the token fields are encrypted at rest, so the app binary
//     is invoked to unlock them; dsh-workbuddy-connect implements that, and we
//     only need to tell it where the binary is.
//   - The credential copy is redirected into THIS package's own state dir.
//     Sharing ~/.dsh/.workbuddy-auth.json with the DSH plugin would put two
//     writers on one refresh token.
//   - Upstream already speaks OpenAI-shaped SSE (including reasoning_content),
//     so streaming is forwarded with light normalization only.
//   - Everything binds to loopback.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CN_VARIANT,
  AI_VARIANT,
  WorkBuddyCredentialStore,
  WorkBuddyUpstreamClient,
  prepareChatBody
} from "dsh-workbuddy-connect";

export const VARIANT_IDS = { cn: "workbuddy", ai: "workbuddy-ai" };

/** Resolve a variant by short region name or provider id. */
export function resolveVariant(name) {
  if (!name) return CN_VARIANT;
  const key = String(name).toLowerCase();
  if (key === "cn" || key === "workbuddy") return CN_VARIANT;
  if (key === "ai" || key === "global" || key === "workbuddy-ai") return AI_VARIANT;
  return undefined;
}

/** Default locations to look for the WorkBuddy / WorkBuddy AI binaries. */
export function defaultElectronCandidates(variant = CN_VARIANT) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const isAi = variant === AI_VARIANT;
  const exe = isAi ? "WorkBuddyAI.exe" : "WorkBuddy.exe";
  const folder = isAi ? "WorkBuddyAI" : "WorkBuddy";
  return [
    path.join(local, "Programs", folder, exe),
    path.join(roaming, "Programs", folder, exe),
    path.join(local, "Programs", folder, "workbuddy.exe"),
    path.join(local, "Programs", folder, "workbuddyai.exe")
  ];
}

/**
 * Resolve the WorkBuddy Electron binary, reporting how and why.
 *
 * An explicitly configured path is authoritative: if the user (or a host app)
 * names a binary, an unusable path is an error rather than a reason to go
 * looking for a different one. Silently substituting another app would mean
 * decrypting with the wrong product's key and reporting a confusing failure
 * far from the actual mistake.
 *
 * @returns {{ path?: string, source: "env" | "detected", invalidEnv?: string }}
 */
export function resolveElectronBinary(variant = CN_VARIANT) {
  const envName = variant === AI_VARIANT ? "WORKBUDDY_AI_ELECTRON_BIN" : "WORKBUDDY_ELECTRON_BIN";
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    // Deliberately no fallback to the other product's variable: pointing the
    // AI variant at the CN binary is a mismatch, not a default.
    if (fs.existsSync(fromEnv)) return { path: fromEnv, source: "env" };
    return { source: "env", invalidEnv: fromEnv };
  }
  const detected = defaultElectronCandidates(variant).find((candidate) => fs.existsSync(candidate));
  return detected === undefined ? { source: "detected" } : { path: detected, source: "detected" };
}

/**
 * Convenience wrapper returning just the path.
 *
 * Returns undefined both when nothing was configured and when a configured path
 * was unusable; use {@link resolveElectronBinary} when the distinction matters
 * (diagnostics and error messages).
 */
export function findElectronBinary(variant = CN_VARIANT) {
  return resolveElectronBinary(variant).path;
}

/**
 * Copy one upstream delta, dropping fields the upstream always emits but OpenAI
 * clients treat as noise (empty tool_calls / function_call, null extra_fields).
 */
function cleanDelta(delta) {
  if (delta === null || typeof delta !== "object") return { content: "" };
  const out = {};
  if (typeof delta.role === "string" && delta.role !== "") out.role = delta.role;
  if (typeof delta.content === "string" && delta.content !== "") out.content = delta.content;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
    out.reasoning_content = delta.reasoning_content;
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls;
  const fn = delta.function_call;
  if (fn !== null && typeof fn === "object") {
    const hasName = typeof fn.name === "string" && fn.name !== "";
    const hasArgs = typeof fn.arguments === "string" && fn.arguments !== "";
    if (hasName || hasArgs) out.function_call = fn;
  }
  return out;
}

/** Normalize one upstream chat.completion.chunk into strict OpenAI shape. */
function cleanChunk(chunk) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  return {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: choices.map((choice) => ({
      index: typeof choice.index === "number" ? choice.index : 0,
      delta: cleanDelta(choice.delta),
      // Upstream uses "" for "not finished"; OpenAI requires null.
      finish_reason:
        typeof choice.finish_reason === "string" && choice.finish_reason !== ""
          ? choice.finish_reason
          : null
    })),
    ...(chunk.usage === undefined || chunk.usage === null ? {} : { usage: chunk.usage })
  };
}

/**
 * Default state directory.
 *
 * Lives under the user's home rather than inside the installed package: a
 * package directory is wiped on reinstall, and this directory holds a cached
 * credential that is expensive to re-derive.
 */
export function defaultStateDir() {
  if (process.env.WORKBUDDY_BRIDGE_STATE) return process.env.WORKBUDDY_BRIDGE_STATE;
  return path.join(os.homedir(), ".workbuddy-openai-bridge");
}

/**
 * Locate the certificate pair created by `workbuddy-cert create`.
 *
 * Returns null when either half is missing, so callers can fall back cleanly
 * instead of starting a listener that cannot complete a handshake.
 */
export function findManagedCertificate(stateDir = defaultStateDir()) {
  const dir = path.join(stateDir, "tls");
  const keyPath = path.join(dir, "bridge-key.pem");
  const certPath = path.join(dir, "bridge-cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), keyPath, certPath };
}

/**
 * Create (but do not start) a bridge instance.
 *
 * @param options.variant     WorkBuddy variant (default: CN).
 * @param options.stateDir    Where this bridge keeps its own credential copy.
 * @param options.modelPrefix Presentation prefix for exposed model ids (default "wb/").
 * @param options.logger      Called with human-readable progress lines.
 */
export function createBridgeServer(options = {}) {
  const log = options.logger ?? (() => {});
  const variant = options.variant ?? CN_VARIANT;
  const stateDir = options.stateDir ?? defaultStateDir();
  const modelPrefix = options.modelPrefix ?? "wb/";
  const catalogTtlMs = options.catalogTtlMs ?? 600_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  const requestBodyLimit = options.requestBodyLimit ?? 64 * 1024 * 1024;

  fs.mkdirSync(stateDir, { recursive: true });

  // Unlock encrypted desktop credentials: dsh-workbuddy-connect disables app
  // discovery unless it is told where the binary is.
  const envName = variant === AI_VARIANT ? "WORKBUDDY_AI_ELECTRON_BIN" : "WORKBUDDY_ELECTRON_BIN";
  const resolved = options.electronBin === undefined
    ? resolveElectronBinary(variant)
    : { path: options.electronBin, source: "option" };
  const electronBin = resolved.path;
  if (resolved.invalidEnv !== undefined) {
    // Explicitly configured but unusable: say so instead of quietly running a
    // different installation. The resulting decryption failure would otherwise
    // surface far away from the actual mistake.
    log(
      `!! ${envName} points at a file that does not exist:\n` +
        `   ${resolved.invalidEnv}\n` +
        `   Fix or unset ${envName}; the bridge will not substitute another installation.`
    );
  }
  if (electronBin) process.env[envName] = electronBin;

  const client = new WorkBuddyUpstreamClient();
  const store = new WorkBuddyCredentialStore({
    variant,
    refresh: (credential) => client.refreshToken(credential),
    // Isolate from DSH: never share ~/.dsh/.workbuddy-auth.json.
    ownPath: path.join(stateDir, ".workbuddy-auth.json")
  });

  let catalog = { at: 0, models: [] };

  const exposeId = (rawId) => `${modelPrefix}${rawId}`;
  const upstreamId = (exposedId) =>
    modelPrefix !== "" && typeof exposedId === "string" && exposedId.startsWith(modelPrefix)
      ? exposedId.slice(modelPrefix.length)
      : exposedId;

  async function currentModels() {
    if (Date.now() - catalog.at < catalogTtlMs && catalog.models.length > 0) return catalog.models;
    try {
      const credential = await store.resolve();
      const models = await client.fetchModels(credential);
      if (models.length > 0) {
        catalog = { at: Date.now(), models };
        log(`catalog: ${models.length} model(s)`);
        return models;
      }
    } catch (error) {
      log(`catalog refresh failed: ${error.message.slice(0, 200)}`);
    }
    return catalog.models;
  }

  function sendJson(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": payload.length
    });
    res.end(payload);
  }

  const sendError = (res, status, message, type = "bridge_error") =>
    sendJson(res, status, { error: { message, type, code: type } });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > requestBodyLimit) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  /** Map an upstream failure class onto an HTTP status. */
  function statusForKind(kind) {
    if (kind === "hard_credit") return 402;
    if (kind === "soft_rate") return 429;
    if (kind === "session_dead") return 401;
    return 502;
  }

  async function streamCompletion(req, res, upstreamBody) {
    let credential;
    try {
      credential = await store.resolve();
    } catch (error) {
      return sendError(res, 401, `not signed in: ${error.message}`, "not_signed_in");
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const result = await client.chatStream(credential, upstreamBody, controller.signal);
    if (!result.ok) {
      return sendError(
        res,
        statusForKind(result.kind),
        `workbuddy upstream: ${result.message.slice(0, 400)}`,
        result.kind
      );
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpIdle();
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "" || line.startsWith(":")) continue; // keep-alive comment
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            res.write("data: [DONE]\n\n");
            continue;
          }
          try {
            res.write(`data: ${JSON.stringify(cleanChunk(JSON.parse(payload)))}\n\n`);
          } catch {
            // An unparsable chunk is dropped rather than emitted as corrupt SSE.
          }
        }
      }
    } finally {
      clearTimeout(idle);
      reader.cancel().catch(() => {});
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Non-streaming: consume the upstream stream and aggregate it, because the
   * upstream is always forced to stream.
   */
  async function collectCompletion(req, res, upstreamBody, requestedModel) {
    let credential;
    try {
      credential = await store.resolve();
    } catch (error) {
      return sendError(res, 401, `not signed in: ${error.message}`, "not_signed_in");
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const result = await client.chatStream(credential, upstreamBody, controller.signal);
    if (!result.ok) {
      return sendError(
        res,
        statusForKind(result.kind),
        `workbuddy upstream: ${result.message.slice(0, 400)}`,
        result.kind
      );
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage = null;
    let id = null;
    let model = requestedModel;
    let created = Math.floor(Date.now() / 1000);
    let finishReason = "stop";
    const toolCalls = [];

    const consume = (payload) => {
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
      if (typeof chunk.created === "number") created = chunk.created;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === "number" ? call.index : toolCalls.length;
          toolCalls[index] ??= { id: call.id, type: "function", function: { name: "", arguments: "" } };
          if (call.id) toolCalls[index].id = call.id;
          if (call.function?.name) toolCalls[index].function.name += call.function.name;
          if (call.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
        finishReason = choice.finish_reason;
      }
    };

    const reader = result.response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        consume(payload);
      }
    }

    const message = { role: "assistant", content };
    if (reasoning !== "") message.reasoning_content = reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls.filter(Boolean);

    return sendJson(res, 200, {
      id: id ?? `chatcmpl-bridge-${Date.now().toString(16)}`,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "GET" && (route === "/health" || route === "/healthz")) {
        const status = await store.status();
        const models = route === "/health" ? await currentModels() : [];
        return sendJson(res, 200, {
          status: "ok",
          upstream: variant.id,
          signIn: status.state,
          ...(status.nickname === undefined ? {} : { nickname: status.nickname }),
          ...(status.domain === undefined ? {} : { domain: status.domain }),
          models: models.length
        });
      }

      if (req.method === "GET" && route === "/v1/models") {
        const models = await currentModels();
        const created = Math.floor(Date.now() / 1000);
        return sendJson(res, 200, {
          object: "list",
          data: models.map((model) => ({
            id: exposeId(model.id),
            object: "model",
            created,
            owned_by: "workbuddy"
          }))
        });
      }

      if (req.method === "POST" && route === "/v1/chat/completions") {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch (error) {
          return sendError(res, 400, `bad json: ${error.message}`);
        }
        const requestedModel = typeof body.model === "string" ? body.model : "";
        // Strip the presentation prefix: upstream recognizes only the real id.
        const wireModel = upstreamId(requestedModel);
        // Upstream requires streaming plus string-form tool_choice; the plugin's
        // own normalizer applies exactly those rewrites.
        const upstreamBody = prepareChatBody(JSON.stringify({ ...body, model: wireModel }));
        return body.stream === true
          ? await streamCompletion(req, res, upstreamBody)
          : await collectCompletion(req, res, upstreamBody, wireModel);
      }

      return sendError(res, 404, `no such route: ${req.method} ${route}`, "not_found");
    } catch (error) {
      log(`handler error: ${String(error).slice(0, 300)}`);
      if (!res.headersSent) sendError(res, 500, String(error), "internal");
      else res.end();
    }
  }

  const server = http.createServer(handle);
  let httpsServer = null;

  return {
    variant,
    store,
    client,
    handle,
    exposeId,
    upstreamId,
    currentModels,

    /** Bind the HTTP listener on an ephemeral port unless one is given. */
    listenHttp(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },

    /**
     * Bind an HTTPS listener.
     *
     * Accepts either a PKCS#12 file (`pfx` + `passphrase`) or a PEM pair
     * (`key` + `cert`), so the certificate produced by `workbuddy-cert create`
     * and a pre-existing PFX both work. Resolves to null when no usable
     * certificate is supplied.
     */
    listenHttps({ port, host = "127.0.0.1", pfx, passphrase, key, cert }) {
      let credentials = null;
      if (key && cert) {
        credentials = { key, cert };
      } else if (pfx && fs.existsSync(pfx)) {
        credentials = { pfx: fs.readFileSync(pfx), passphrase };
      }
      if (credentials === null) return Promise.resolve(null);

      httpsServer = https.createServer(credentials, handle);
      return new Promise((resolve, reject) => {
        httpsServer.once("error", reject);
        httpsServer.listen(port, host, () => {
          httpsServer.removeListener("error", reject);
          resolve(httpsServer.address().port);
        });
      });
    },

    /** Sign-in summary; never throws. */
    status: () => store.status(),

    async close() {
      await new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
      if (httpsServer?.listening) {
        await new Promise((resolve) => httpsServer.close(resolve));
      }
    }
  };
}
