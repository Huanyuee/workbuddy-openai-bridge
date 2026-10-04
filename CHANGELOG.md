# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-04

First public release.

### Added

- **OpenAI-compatible bridge** for a WorkBuddy desktop-app sign-in.
  `GET /v1/models`, `POST /v1/chat/completions` (streaming and non-streaming),
  and `GET /health`. Upstream is already OpenAI-shaped, including
  `reasoning_content`, so responses are forwarded with light normalization:
  empty `tool_calls` / `function_call` are dropped and `finish_reason: ""`
  becomes `null`.
- **Pi extension** (`@earendil-works/pi-coding-agent`). Registers a `workbuddy`
  provider and starts the bridge **in-process** on an ephemeral loopback port, so
  there is no separate daemon and no fixed port to collide with. Installing is a
  single `pi install npm:workbuddy-openai-bridge`.
- **MolaGPT setup command** (`workbuddy-setup-molagpt`). Works around MolaGPT's
  `LooksLikeChatModel` filter, which recognizes only ids matching a hard-coded
  vendor token list and therefore surfaces just the two `deepseek-*` models out
  of the full roster. Dry-run by default; backs the database up before writing
  and refuses to run while MolaGPT is open.
- **Certificate command** (`workbuddy-cert`) with `create`, `trust`, `untrust`,
  and `status`. Generates a self-signed certificate carrying SANs for both
  `localhost` and `127.0.0.1`, and can install it into the OS trust store, which
  .NET-based clients such as MolaGPT require.
- **Standalone server** (`workbuddy-bridge`) for any OpenAI-compatible client,
  with optional HTTPS and a `--doctor` diagnostics mode.
- **`wb/` model prefix**, applied on `/v1/models` and stripped from chat
  requests before they reach upstream. Set `WORKBUDDY_MODEL_PREFIX=""` (or
  `--prefix ""`) to disable.
- Support for the international **WorkBuddy AI** product via
  `--variant ai` / `WORKBUDDY_VARIANT=ai`.

### Security

- **Credential isolation.** The bridge keeps its own credential copy and never
  reads or writes DSH's `~/.dsh/.workbuddy-auth.json`. Two writers sharing one
  refresh token would invalidate each other.
- **Loopback only.** Every listener binds `127.0.0.1`.
- **Trust-store removal is scoped by certificate thumbprint, never by subject
  name.** Unrelated `CN=localhost` certificates are common on developer machines;
  a name-based delete would remove them and break other tools. `untrust` only
  ever removes the certificate this package generated.
- **Trust-scope default is the current user**, which needs no administrator
  rights. Machine-wide installation is opt-in via `--machine` and warns first.
- Credentials, prompts, and response bodies are never logged.

### Known limitations

- Relies on WorkBuddy's private client APIs, not an official public API;
  upstream changes can break it.
- The international variant's model catalog comes from an app UI endpoint and is
  less stable than the CN variant's CLI-shaped one.
- Pi's `calculateCost()` dereferences `model.cost` unconditionally. WorkBuddy
  bills in its own credits rather than USD, so this package reports zeros to
  keep Pi from inventing a dollar figure.
- The Pi extension does **not** work under MolaGPT, which launches its bundled Pi
  sidecar with `--no-extensions` and thus skips the extension discovery path.
  MolaGPT users should use the setup command instead.
- On Windows `pi install` records a relative path; moving the directory requires
  reinstalling.
- Requires Node.js >= 22.5 (`node:sqlite`, `AbortSignal.any`).

[1.0.0]: https://github.com/Huanyuee/workbuddy-openai-bridge/releases/tag/v1.0.0
