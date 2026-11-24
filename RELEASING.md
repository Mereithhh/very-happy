# Releasing `very-happy-cli`

## Draft the user-facing changelog

Before a Web or CLI release, generate a reviewable draft from the commits since
the previous tag:

```sh
pnpm changelog:draft
# Explicit range when the release train does not start at the latest tag:
pnpm changelog:draft -- --from v0.2.80 --to HEAD
```

The command includes only conventional `feat`, `fix`, and `perf` subjects and
groups them into a Markdown draft. It deliberately does **not** edit the product
changelog or publish raw commit messages. Rewrite the draft for users, add the
English and Simplified Chinese copy plus a stable release id to
`packages/happy-web-v2/src/app/changelogRelease.ts`, then run the Web gates.
The popup shows only the latest unseen release; `/changelog` retains the full
fork-era history.

The published artifact is the npm package **`very-happy-cli`** (source:
`packages/happy-cli`). Once set up, releasing is one command: **push a tag**.

```
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions (`.github/workflows/publish.yml`) then builds the package, sets
its version from the tag (`v0.1.1` → `0.1.1`), verifies the `@slopus/happy-wire`
dependency is bundled in, publishes the six `very-happy-tools-*` packages and
then `very-happy-cli` under the `next` dist-tag, and (job `promote`) moves
`latest` once the smoke matrix is green. npm authentication is **trusted
publishing** (GitHub OIDC) — no long-lived token in steady state.

That's the steady state. Below is the **one-time setup** to get there.

---

## One-time setup

### 1. Make sure the npm name is free
Check <https://www.npmjs.com/package/very-happy-cli> returns 404. If it's
taken, pick another `name` in `packages/happy-cli/package.json` and update this
doc + the workflow filters.

### 2. First publish (manual — bootstraps the package)
A trusted publisher can only be attached to a package that already *exists*, so
do the very first publish by hand from your machine:

```
npm login                       # your npmjs.com account (with 2FA if enabled)
cd <repo root>
pnpm install --frozen-lockfile
pnpm --filter very-happy-cli build
pnpm --filter very-happy-cli publish --no-git-checks --access public
```

After this, `npm i -g very-happy-cli` works for anyone. (Already done for all
seven packages below.)

### 3. Create the GitHub repo and push
```
gh repo create Mereithhh/very-happy --public --source . --remote origin --push
# or: create the repo in the UI, then
#   git remote add origin git@github.com:Mereithhh/very-happy.git
#   git push -u origin <branch>
```
`package.json` already points `repository`/`homepage`/`bugs` at this repo.
Trusted publishing requires each package's `repository.url` to match this
GitHub repository exactly — all seven do.

### 4. Configure a trusted publisher on every package
Prerequisite: the npm account that maintains the packages has **2FA enabled**.

For **each** of these seven packages, open the package **Settings** page
(`https://www.npmjs.com/package/<name>/access`) → **Trusted Publisher** →
**GitHub Actions** and enter:

| Package | Allowed actions |
| --- | --- |
| `very-happy-cli` | **`npm publish`** + **Allow `npm dist-tag`** |
| `very-happy-tools-arm64-darwin` | `npm publish` |
| `very-happy-tools-arm64-linux` | `npm publish` |
| `very-happy-tools-arm64-win32` | `npm publish` |
| `very-happy-tools-x64-darwin` | `npm publish` |
| `very-happy-tools-x64-linux` | `npm publish` |
| `very-happy-tools-x64-win32` | `npm publish` |

Fields (identical for all seven; case-sensitive, npm does not validate them on
save — a typo only shows up as a failed publish):

- **Organization or user:** `Mereithhh`
- **Repository:** `very-happy`
- **Workflow filename:** `publish.yml` (file name only, with the extension)
- **Environment name:** leave empty

Why `very-happy-cli` also needs **Allow npm dist-tag**: the `promote` job runs
`npm dist-tag add very-happy-cli@<version> latest`. Since npm CLI 11.21.0,
`npm dist-tag` authenticates through OIDC, but only for a trusted publisher
with that option ticked; it is off by default and independent of `npm
publish` (npm docs, *Trusted publishing → Managing dist-tags with trusted
publishing*). The tool packages only ever receive the default `latest` from
`npm publish`, so they need publish only.

How the workflow uses it:

- `publish` and `promote` both have `permissions: id-token: write`; the
  workflow runs only on `v*` tags and `workflow_dispatch`, never on
  `pull_request`, so fork code can never mint an id-token.
- The `publish` job installs and **builds on Node 20** (pkgroll targets the
  running Node; the CLI still supports `^20.19`), then switches to Node 22
  with a pinned npm (`npm@11.21.2`; trusted publishing needs Node ≥ 22.14 and
  npm ≥ 11.5.1, dist-tag over OIDC ≥ 11.21.0) only for the publish steps.
  `promote` builds nothing and uses Node 22 + the same npm throughout.
- Every npm write goes through `scripts/release/npm-oidc-or-token.sh`, which
  first runs the command with no usable token, so it can only succeed via
  OIDC. Provenance attestations are generated automatically on that path (no
  `--provenance` flag needed).

### 5. Transition fallback: `NPM_TOKEN` (temporary)
Until the first release is seen to publish **and** promote through OIDC, the
repo secret `NPM_TOKEN` stays as a fallback: when the OIDC attempt fails, the
helper retries the same command with the token and leaves a
`::warning title=npm auth::… OIDC trusted publishing failed; retrying with the
NPM_TOKEN fallback` annotation on the run. A green run with that warning is
**not** a successful migration — fix the trusted publisher config.

Once OIDC is confirmed, delete the fallback branch from the helper and the
secret (`gh secret delete NPM_TOKEN --repo Mereithhh/very-happy`), then on each
package's **Settings → Publishing access** choose *Require two-factor
authentication and disallow tokens* (trusted publishing keeps working).

### Verifying the first OIDC release
1. Open the `Publish very-happy-cli` run for the tag (`gh run view <id> --log`
   or the Actions UI) and check the run's **Annotations**:
   - expected: seven notices `publish <pkg>@<version>: authenticated via OIDC
     trusted publishing` (job `publish`) and one notice `dist-tag
     very-happy-cli@<version> latest: authenticated via OIDC trusted
     publishing` (job `promote`);
   - no `npm auth` **warning** anywhere. A warning names the exact package or
     dist-tag that fell back to `NPM_TOKEN`.
   - `Pin npm for trusted publishing` prints `11.21.2`.
2. Check provenance landed (only OIDC publishes get it automatically):
   `npm view very-happy-cli@<version> dist.attestations --json` shows a
   `provenance` entry, and the package page shows the *Built and signed on
   GitHub Actions* badge. Repeat for one `very-happy-tools-*` package.
3. Packages that were *already published* for that version (re-run) print
   `Already published: …` and produce no notice; verify on a fresh version.

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
- **Default server** is `https://veryhappy.dev` (override with
  `HAPPY_SERVER_URL` / `HAPPY_WEBAPP_URL` or `~/.happy/settings.json`).
- **2FA:** trusted publishing (OIDC) is not subject to the 2FA prompt, so CI
  publishes don't get blocked. The transition `NPM_TOKEN` fallback is a
  granular token with 2FA bypass and is meant to be short-lived; remove it as
  soon as OIDC is confirmed (step 5).
