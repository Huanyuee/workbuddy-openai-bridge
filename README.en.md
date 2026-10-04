# workbuddy-openai-bridge

Turn a **WorkBuddy desktop app** sign-in into a standard **OpenAI-compatible
endpoint**, so Pi (`pi-coding-agent`), MolaGPT, and any OpenAI-compatible client
can use the models bundled with your WorkBuddy account.

```
Pi / MolaGPT / any OpenAI client
        │  OpenAI-compatible (HTTP/HTTPS)
        ▼
workbuddy-openai-bridge ──► copilot.tencent.com
        │
        └── credentials come from the WorkBuddy desktop app sign-in
```

## Sharing with a friend

Just send the repository URL: **https://github.com/Huanyuee/workbuddy-openai-bridge**

They need the **same prerequisites** — this is the part most easily missed, so
state it up front:

- They must have **installed and signed in** to the WorkBuddy desktop app (or
  WorkBuddy AI) themselves. This tool reuses the **local** app sign-in; it cannot
  borrow your account or your credit.
- Node.js ≥ 22.5

Then, by scenario:

```sh
# using Pi
pi install git:https://github.com/Huanyuee/workbuddy-openai-bridge

# using MolaGPT
npm install -g github:Huanyuee/workbuddy-openai-bridge
workbuddy-bridge                     # keep running in another window
# add the provider in MolaGPT: https://localhost:9443/v1
workbuddy-setup-molagpt --apply
```

When you share the link, add one line: **this is for people who already have
WorkBuddy installed** — otherwise they may expect it to use your credit.

## Requirements

1. **WorkBuddy (or WorkBuddy AI) desktop app installed and signed in once**
   - One sign-in is enough; the app does **not** need to stay running
   - The app must **not be uninstalled**: since 5.6 its tokens are encrypted at
     rest and the app binary is invoked to unlock them
2. **Node.js ≥ 22.5** (for `node:sqlite` and `AbortSignal.any`)

## Install

> **Not published to npm yet.** The `npm:` forms below work only after a
> release; use the GitHub source meanwhile (verified working).

### From GitHub (available now)

```sh
# global commands (workbuddy-bridge / workbuddy-cert / workbuddy-setup-molagpt)
npm install -g github:Huanyuee/workbuddy-openai-bridge

# or as a project dependency
npm install github:Huanyuee/workbuddy-openai-bridge
```

### From npm (after a release)

```sh
npm install -g workbuddy-openai-bridge
```

## Usage 1: Pi extension (recommended)

```sh
# available now
pi install git:https://github.com/Huanyuee/workbuddy-openai-bridge

# once published to npm
pi install npm:workbuddy-openai-bridge
```

Nothing else to configure. Pi discovers the extension, which starts the bridge
**in-process** on an ephemeral port (no daemon to babysit) and registers a
`workbuddy` provider:

```
provider   model                   context  max-out  thinking  images
workbuddy  wb/hy4-preview          960K     64K      yes       yes
workbuddy  wb/deepseek-v4.1-flash  1M       128K     yes       yes
workbuddy  wb/glm-5.3              1M       64K      yes       yes
workbuddy  wb/kimi-k2.6            256K     32K      yes       yes
...19 models total
```

```sh
pi --model wb/hy3 -p "hello"

# one-off, without installing
pi -e node_modules/workbuddy-openai-bridge/extensions/workbuddy.js --model wb/glm-5.3
```

> **`pi install` only helps a standalone Pi.** MolaGPT launches its bundled Pi
> sidecar with `--no-extensions`, which skips exactly this discovery path, so
> MolaGPT users need Usage 2.

## Usage 2: MolaGPT

MolaGPT's "auto-detect" filters model ids through a hard-coded vendor token list
(`LooksLikeChatModel`), so out of ~19 WorkBuddy models only the two whose names
contain `deepseek` survive. This package writes the records directly, bypassing
that filter:

```sh
# 1. In MolaGPT, add a provider:
#      type    OpenAI-compatible
#      address https://localhost:9443/v1
#      API key anything (the bridge does not authenticate callers)

# 2. Quit MolaGPT completely

# 3. Start the bridge (the script reads the roster from upstream)
workbuddy-bridge

# 4. Preview the write (does not touch the database)
workbuddy-setup-molagpt

# 5. Commit
workbuddy-setup-molagpt --apply

# 6. Restart MolaGPT
```

The script backs the database up to `~/MolaGPT-backup/molagpt-<timestamp>.db`,
refuses to run while MolaGPT is open, and is dry-run by default.

> Restart MolaGPT **before** opening that provider's settings page: a live
> instance can overwrite this write with its in-memory list.

## Usage 3: standalone server

For any OpenAI-compatible client (SillyTavern, Cherry Studio, scripts).

```sh
workbuddy-bridge                          # defaults
workbuddy-bridge --port 8899 --no-https
workbuddy-bridge --variant ai             # international WorkBuddy AI
workbuddy-bridge --doctor                 # diagnostics only
```

| Endpoint | Description |
|---|---|
| `http://127.0.0.1:8899/v1` | OpenAI-compatible (plain) |
| `https://localhost:9443/v1` | OpenAI-compatible (TLS, needs a cert) |
| `GET /v1/models` | model list |
| `POST /v1/chat/completions` | chat, `stream` supported |
| `GET /health` | health, sign-in state, model count |

HTTPS takes a PKCS#12 certificate via `--pfx`, or generate and trust one with
`workbuddy-cert` (below). A self-signed certificate must already be trusted, or
.NET-based clients will refuse it; prefer `localhost` over `127.0.0.1`.

## Certificates: generate and trust

.NET apps such as MolaGPT validate the certificate chain, so a self-signed
certificate is unusable until the OS trusts it. This command does both halves,
and can undo both:

```sh
workbuddy-cert create            # generate key + certificate (no trust change)
workbuddy-cert trust             # install into the current-user trust store
workbuddy-cert status            # show state and whether it is trusted
workbuddy-cert untrust           # remove from the trust store (ours only)
workbuddy-cert untrust --purge   # also delete the certificate files
```

Once trusted, `workbuddy-bridge` picks it up automatically — no `--pfx` needed.

### Safety

Installing into a trust store is security-sensitive, so:

- It is **never automatic**; you must run `workbuddy-cert trust` yourself.
- Removal is scoped by **certificate thumbprint, never by subject name**. A
  machine commonly already holds unrelated `CN=localhost` certificates (this
  one had three); a name-based delete would remove them and break other tools.
- `untrust` only ever removes the certificate **this package generated**.
- The scope defaults to the **current user** (no administrator rights needed).
  Installing machine-wide requires an explicit `--machine` and warns first.

### Options

| Flag | Description |
|---|---|
| `--hostname <name>` | primary DNS name (default `localhost`) |
| `--extra-host <list>` | extra names/IPs, comma-separated |
| `--days <n>` | validity in days (default 3650) |
| `--machine` | use the machine-wide store (needs admin) |
| `--state-dir <path>` | state directory |

The generated certificate carries SANs for both `localhost` and `127.0.0.1`, so
either spelling works. This feature needs the optional `selfsigned` package; if
it is absent only this command is unavailable.


## Model prefix

Exposed ids carry a `wb/` prefix so their origin is obvious. It is presentation
only: added on `/v1/models`, stripped from chat requests before they reach
upstream.

```sh
workbuddy-bridge --prefix ""        # disable
export WORKBUDDY_MODEL_PREFIX=wb/
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WORKBUDDY_VARIANT` | `cn` | `cn` or `ai` |
| `WORKBUDDY_MODEL_PREFIX` | `wb/` | model id prefix |
| `WORKBUDDY_BRIDGE_STATE` | `~/.workbuddy-openai-bridge` | credential copy dir |
| `WORKBUDDY_ELECTRON_BIN` | auto-detect | path to WorkBuddy.exe |
| `WORKBUDDY_AI_ELECTRON_BIN` | auto-detect | path to WorkBuddyAI.exe |

CLI flags override environment variables; see `workbuddy-bridge --help`.

## Troubleshooting

**`not signed in`** — sign in once in the WorkBuddy desktop app, then restart
the bridge (or `/reload` in Pi).

**`no WorkBuddy binary found`** — auto-detection failed; point at the app:

```sh
set WORKBUDDY_ELECTRON_BIN=%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe
export WORKBUDDY_ELECTRON_BIN="/Applications/WorkBuddy.app/Contents/MacOS/Electron"
```

**Empty model list** — run `workbuddy-bridge --doctor` and read the `sign-in`
and `models` lines.

**MolaGPT shows only 2 deepseek models** — that is MolaGPT's filter; use the
Usage 2 script.

## How it works

- **Credentials** come from `dsh-workbuddy-connect`, which implements the
  WorkBuddy credential decryption, catalog, and upstream protocol.
- **Isolation**: this package keeps its **own** credential copy and never shares
  DSH's `~/.dsh/.workbuddy-auth.json` — two writers on one refresh token would
  invalidate each other.
- **Wire adaptation**: upstream requires forced streaming and string-form
  `tool_choice`; `prepareChatBody` applies exactly those rewrites. Upstream is
  already OpenAI-shaped (including `reasoning_content`).
- **Normalization**: empty `tool_calls`/`function_call` are dropped and
  `finish_reason: ""` becomes `null`.

## Verified

All of the following were tested against a real WorkBuddy account:

| Item | Result |
|---|---|
| encrypted credential decryption | ok |
| model catalog | 19 models |
| non-streaming chat | ok |
| streaming chat (SSE + `[DONE]`) | ok |
| `reasoning_content` passthrough | ok (236 fragments on glm-5.3) |
| `wb/` prefix stripping | ok (`wb/glm-5.3` → `glm-5.3`) |
| Pi extension: discovered after `pi install` | ok |
| Pi extension: real chat | ok |
| Pi extension: model metadata | ok |
| credential isolation from DSH | ok |
| standalone HTTP / HTTPS | ok |
| `workbuddy-cert create` + correct SANs | ok |
| HTTPS validates under **default** trust after `trust` | ok |
| `workbuddy-cert untrust` removes only its own cert | ok (3 pre-existing kept) |
| clean install (tarball → fresh dir) | ok |

## Known limitations

- Relies on WorkBuddy's **private client APIs**, not an official public API;
  upstream changes can break it.
- The international variant's catalog comes from an app UI endpoint and is less
  stable than the CN variant's CLI-shaped one.
- Pi's `calculateCost()` dereferences `model.cost` unconditionally. WorkBuddy
  bills in its own credits rather than USD, so this package reports zeros to
  keep Pi from inventing a dollar figure.
- On Windows `pi install` records a relative path; moving the directory breaks
  it and requires reinstalling.

## Disclaimer

- For **personal study and research only**; it drives your own WorkBuddy account
  from your own machine.
- Respect WorkBuddy's terms of service; you bear any consequences (account
  restrictions, cleared credit, service interruption).
- Not affiliated with, endorsed by, or authorized by Tencent, WorkBuddy, or
  DeepSeek.

## License

MIT
