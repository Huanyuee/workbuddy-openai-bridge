# Releasing

This document covers publishing the package to npm and pushing the repository to
GitHub. Nothing here is automated: publishing is irreversible (npm does not allow
re-using a version number) and both steps need credentials this repository does
not have and should not hold.

## Credentials you need

| Task | Requires | Where it lives |
|---|---|---|
| `git commit` | a name + email (any values) | local git config |
| `git push` to GitHub | a GitHub account + a token or SSH key | your machine / credential manager |
| `npm publish` | a **npm** account, logged in on this machine | `~/.npmrc` |

An npm account and a GitHub account are separate; publishing to npm does **not**
require GitHub, and pushing to GitHub does **not** require npm. There is no
account of mine involved in either step.

Check the current state:

```sh
git config --global user.name
npm whoami          # fails with ENEEDAUTH when not logged in
```

## Before the first publish

The git identity and the `repository`, `homepage`, and `bugs` fields in
`package.json` are already filled in for `Huanyuee/workbuddy-openai-bridge`, so
the first release needs no edits. Keep them in step if the repository ever moves:

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

## Publishing to npm

```sh
npm login                       # once per machine
npm whoami                      # confirm
npm publish --dry-run           # inspect exactly what would be uploaded
npm publish --access public     # scoped names need --access public; this one does not
```

The `files` field in `package.json` keeps the tarball to source, docs, and
licence — `node_modules`, `.state/`, and TLS material never ship. Confirm with
`npm publish --dry-run` before every release.

Afterwards:

```sh
npm view workbuddy-openai-bridge version
```

### Version bumps

Semantic versioning, with one project-specific caveat: a change in the shape of
WorkBuddy's upstream API is a **minor** bump when the bridge still works, and a
**major** one when it does not. Bump, then update `CHANGELOG.md`:

```sh
npm version patch   # or minor / major — also creates the git tag
git push --follow-tags
```

### If a release is broken

```sh
npm deprecate workbuddy-openai-bridge@1.0.0 "reason; use 1.0.1"
```

Unpublishing is only possible within 72 hours and is heavily restricted. Prefer
publishing a fixed version and deprecating the bad one.

## Pushing to GitHub

The repository is already initialised, committed, tagged `v1.0.0`, and has its
`origin` remote configured for `Huanyuee/workbuddy-openai-bridge`. To (re)create
it from scratch, use the `gh` CLI — it creates the repository and pushes in one
step, and needs no manual setup on the website:

```sh
gh auth login                      # one-time, device flow
gh repo create workbuddy-openai-bridge --public \
  --source . --push --description "Expose a WorkBuddy desktop-app sign-in as an OpenAI-compatible endpoint for Pi and MolaGPT"
git push origin --tags
```

Without `gh`, create an **empty** repository on GitHub first (no README, no
`.gitignore`, no licence — this repository already has all three), then:

```sh
git remote add origin git@github.com:Huanyuee/workbuddy-openai-bridge.git
git push -u origin main --follow-tags
```

Use the HTTPS URL instead if you prefer a token over SSH keys:

```sh
git remote add origin https://github.com/Huanyuee/workbuddy-openai-bridge.git
```

## Verifying a release

After publishing, confirm a clean install works — the same check used before
release, in a scratch directory:

```sh
mkdir /tmp/verify && cd /tmp/verify
npm init -y
npm install workbuddy-openai-bridge@latest
npx workbuddy-bridge --doctor
```

Expected: it locates the WorkBuddy binary, reports `sign-in : signed-in`, and
lists the model roster. A missing binary or a `signed-out` state is an
environment problem, not a packaging one.

Then exercise the three entry points:

```sh
pi install npm:workbuddy-openai-bridge     # Pi
npx workbuddy-cert create && npx workbuddy-cert trust
npx workbuddy-bridge                        # standalone
```

## If the trust-store step is ever automated

Do not. `workbuddy-cert trust` writes to an OS trust store, which is a
security-sensitive action and must stay an explicit user decision. If you ever
add a postinstall hook, keep certificate installation out of it.
