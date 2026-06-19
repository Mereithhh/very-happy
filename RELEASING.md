# Releasing `very-happy-cli`

The published artifact is the npm package **`very-happy-cli`** (source:
`packages/happy-cli`). Once set up, releasing is one command: **push a tag**.

```
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions (`.github/workflows/publish.yml`) then builds the package, sets
its version from the tag (`v0.1.1` → `0.1.1`), verifies the `@slopus/happy-wire`
dependency is bundled in, and runs `npm publish --access public`.

That's the steady state. Below is the **one-time setup** to get there.

---

## One-time setup

### 1. Make sure the npm name is free
Check <https://www.npmjs.com/package/very-happy-cli> returns 404. If it's
taken, pick another `name` in `packages/happy-cli/package.json` and update this
doc + the workflow filters.

### 2. First publish (manual — bootstraps the package)
A scoped/granular CI token can only target a package that already *exists*, so
do the very first publish by hand from your machine:

```
npm login                       # your npmjs.com account (with 2FA if enabled)
cd <repo root>
pnpm install --frozen-lockfile
pnpm --filter very-happy-cli build
pnpm --filter very-happy-cli publish --no-git-checks --access public
```

After this, `npm i -g very-happy-cli` works for anyone.

### 3. Create the GitHub repo and push
```
gh repo create Mereithhh/very-happy --public --source . --remote origin --push
# or: create the repo in the UI, then
#   git remote add origin git@github.com:Mereithhh/very-happy.git
#   git push -u origin <branch>
```
`package.json` already points `repository`/`homepage`/`bugs` at this repo.

### 4. Create an npm token for CI
On npmjs.com → your avatar → **Access Tokens** → **Generate New Token**:
- Prefer a **Granular Access Token**: scope **Packages and scopes → only
  `very-happy-cli` → Read and write**, set an expiry, **no IP allowlist**.
- (Simpler alternative: a classic **Automation** token — account-wide, bypasses
  2FA, no expiry.)

Copy the token (shown once).

### 5. Add the token as a repo secret
```
gh secret set NPM_TOKEN --repo Mereithhh/very-happy
# paste the token when prompted
```
(Or repo → Settings → Secrets and variables → Actions → New repository secret,
name `NPM_TOKEN`.)

---

## From now on: release by tag

```
git tag v0.1.2
git push origin v0.1.2
```

- The **tag** is the source of truth for the version — you do **not** edit
  `package.json`'s version by hand.
- Watch the run under the repo's **Actions** tab.
- You can also trigger `publish.yml` manually (workflow_dispatch); without a tag
  it publishes whatever version is in `package.json`.

### Tagging conventions
- `v0.1.2` → stable `0.1.2`.
- `v0.2.0-beta.1` → npm prerelease (won't be installed by `npm i` without
  `@beta`); good for testing before a stable cut.

---

## Notes / gotchas
- **Single self-contained package.** `@slopus/happy-wire` is in `devDependencies`
  so pkgroll inlines it into `dist`; consumers never touch the `@slopus` scope.
  The publish/smoke workflows fail loudly if that bundling ever regresses.
- **Package is ~105 MB** — it ships prebuilt `ripgrep`/`difftastic` for all 6
  platforms (`tools/archives/`). The `postinstall` (`scripts/unpack-tools.cjs`)
  unpacks the right one; **unsupported platforms fail to install** (no fallback).
- **Runtime prerequisite:** users must have Claude Code installed and logged in
  (`claude` on PATH). Documented in the package README.
- **Default server** is `https://happy.mereith.com` (override with
  `HAPPY_SERVER_URL` / `HAPPY_WEBAPP_URL` or `~/.happy/settings.json`).
- **2FA:** automation and granular tokens both bypass the npm 2FA prompt, so CI
  publishes don't get blocked.
