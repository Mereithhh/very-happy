# Open-source readiness

> Assessment date: 2026-08-24 (Asia/Singapore)  
> Candidate branch: `main`  
> Production CLI: `very-happy-cli@0.2.58` (`v0.2.58`)
> Decision: **NOT READY to change repository visibility yet**

The application and deployment candidate are ready for Owner acceptance. There are no
known code, product, documentation, or current-tree P0/P1 issues in the frozen scope.
The sole public-release blocker is historical: the existing Git object database contains
credentials and real session material. A normal commit cannot remove it, and the Owner
explicitly reserved history rewriting and credential rotation. Do not make this repository
public until the procedure below is complete.

## What is complete

- A responsive public landing page explains the product, capabilities, first connection,
  Cloud versus self-hosting, upstream origin, and the real trust boundary.
- Public positioning now owns a broader agent-workspace category: “Work anywhere. Keep the
  thread.” It distinguishes current Claude/Codex/ACP capabilities from Pi/provider-gateway
  roadmap and the long-term virtual-office concept, and states the Claude/voice prerequisites
  for the optional meta-agent.
- Public Web docs cover quick start, CLI/daemon, Cloud, self-hosting, configuration,
  architecture/data flow, integrations/automation, security/privacy, accounts/quotas,
  upgrades/rollback, troubleshooting, and contributing.
- A real but scrubbed Tanka field note demonstrates the generic IM-to-session loop without
  publishing private infrastructure. It explicitly separates that adapter from the shipped
  Claude coordinator and future provider gateway. The public adapter example now fails closed
  on sender/chat authorization, fixed workspace mappings, deduplication, and rate limits.
- Password and Google signup/login, capacity states, network/authentication errors,
  terminal approval, first-machine recovery, and CLI commands form one coherent journey.
- Public language consistently says **server-trusted, not end-to-end encrypted**. It does
  not promise zero knowledge, operator blindness, durability, SLA, or undeletable data.
- Fork PR code is confined to GitHub-hosted runners with read-only contents permission.
  Deploy and npm publish workflows do not accept PR triggers.
- Account creation is transactionally gated; password verification is asynchronous scrypt;
  authentication limiters fail fast without consuming broader buckets; Google/password
  sessions are created in their signup transaction.
- Machine/session/message/attachment creation has shared database-backed resource limits.
  Socket RPC ownership, pairing claim TTL/single-use, remote logging, log redaction,
  webhook SSRF, and OAuth redirect/origin boundaries are hardened and regression-tested.
- The standalone image uses whitelist build inputs, embeds Web V2, runs migrations before
  serving, persists PGlite under `/data`, supports external PostgreSQL, and does not ship
  Electron, node-pty, local `.env`, database, log, or JSONL artifacts.
- The server npm package contains its runtime, Web V2 bundle, Prisma client, and migrations.
  CLI help/runtime strings use `very-happy`; fixture PII and real local paths are removed
  from the current tree.
- The production updater now resolves an exact registry version, allowlists only the
  reviewed CLI/node-pty install hooks, verifies the installed version, then restarts.

## Verification evidence

### Clean checkout and package gates

A no-hardlink clone with `pnpm install --frozen-lockfile` completed successfully. On the
candidate source, the required gates passed:

| Surface | Evidence |
|---|---|
| Web V2 | 97 test files / 1,402 tests; Vite production build; TypeScript 0 errors |
| CLI | 105 test files / 1,145 tests; build; isolated `HAPPY_HOME_DIR`; runtime reports 0.2.57 |
| Server | 34 test files / 281 tests; TypeScript 0 errors |
| CI | Quality Gates run `32664535539` passed for workspace source `212665e6`; setup/action pins resolve to real immutable commits |
| Dependencies | production audit: 0 critical/high; 28 moderate and 9 low advisories remain |

Server and CLI tarballs were installed into isolated locations. The server tarball migrated
an empty PGlite database through 42 migrations. The CLI tarball executed its postinstall and
runtime/version smoke without relying on workspace packages.

### Container and database smoke

- Final image size: 1,545,358,994 bytes; runtime `node_modules`: approximately 495 MB.
- Electron and node-pty are absent from the server image.
- PGlite: migrations, health, landing/docs/signup config injection, password signup,
  container recreation, volume persistence, and login all passed.
- PostgreSQL 16: `prisma migrate deploy`, server startup, and a real password signup passed.
- Sentinel `.env` and local-data values were confirmed absent from the resulting layers.
- `same-origin` config is covered at server resolution, Web client resolution, and real
  container `/`, `/docs`, and `/signup` integration levels.

### Browser acceptance

Fresh isolated browser profiles covered desktop and 390x844 mobile layouts:

- production landing and all 12 documentation chapters render with no horizontal overflow;
- skip-to-content is the first focus target and navigation/regions have accessible names;
- the landing prominently discloses “server-trusted, not end-to-end encrypted”;
- quick start includes install, login approval, daemon start, and first-session commands;
- signup shows Google plus password fields when configured, with account-policy recovery;
- a fresh standalone server sends auth/config only to its own origin and never contacts
  `happy.mereith.com` unless explicitly configured;
- local isolated signup → first-run onboarding passed without console errors;
- production health, hashed JavaScript MIME, signup capacity, landing, docs, and signup
  were rechecked after deployment. A fresh mobile browser also confirmed the final signup
  title, 390px no-overflow layout, complete auth choices/recovery links, and no console warning.
- the anonymous public root is isolated from auth/sync/crypto: fresh production mobile loaded
  about 217 KB and no `AppRoot`/crypto chunk. Under 1.6 Mbps, 150 ms RTT, 4x CPU review
  throttling, LCP improved from 6.37 s to 1.85 s. The service worker now precaches only seven
  entry/manifest/icon resources and caches hashed app assets on demand.

### Independent review

Three independent read-only review tracks were completed after implementation:

1. Security/public-repository review: P0=0, code P1=0; history cleanup is the sole P1 blocker.
2. First-user/UI/browser review: P0=0, P1=0 after same-origin regression coverage.
3. Documentation/shipping-image review: P0=0, P1=0 after runtime closure and container smoke.

Confirmed findings were fixed and re-reviewed rather than moved to a TODO list.

The subsequent public-positioning release received two additional independent passes. The
UX/docs pass closed misleading roadmap/status, meta-agent prerequisite, hero-concept, npm
trust, and OpenCode-command findings. The browser pass closed the anonymous 1.12 MB / poor-LCP
finding and rechecked landing→docs/signup/login routing. Both ended at P0=0, P1=0.

The IM field-note follow-up received another bounded review. It found and fixed a missing
sender/chat authorization gate in the public adapter pseudocode, removed internal deployment
details from the historical Tanka spec, and verified that IM dispatch and the Claude
coordinator are described as separate shipped paths. The regression test pins those boundaries.

## Release and production state

- Server then Web were deployed from release source SHA `e4ece34b7305135d19a12a1c8cf5caf8876d7e0f`
  by Actions run `32661273319`.
- The browser-discovered auth-title polish fix was Web-only deployed from SHA
  `1f89ff565aa4021fefd908e88bf2c24766ed1515` by run `32662050686` after its full Quality
  Gates run passed.
- The agent-workspace landing, lightweight anonymous root, on-demand PWA asset cache, and
  multi-agent documentation were Web-only deployed from SHA
  `208dc4a5f403e0cdf8fb5898f50e568cf27bc6c1` by run `32663553280`. Production health,
  JavaScript MIME, 390px layout, trust disclosure, public transfer size, and precache scope
  were verified afterward.
- The scrubbed agent-system field note and Integrations chapter were Web-only deployed from
  final SHA `212665e64f64be8814924383063e79bbc3a14af1` by run `32664648352` after exact-SHA
  Quality Gates run `32664535539` passed. A fresh isolated production browser verified the
  corrected configured-notification/fixed-workspace wording, JavaScript MIME, anonymous
  bundle isolation, 390px no-overflow layout, and both integration safety notes.
- The deploy verified migration-before-serve, returned health 200 after both restarts, and
  served the versioned main asset as `application/javascript`.
- The initial candidate CLI `v0.2.57` pointed at the server release source SHA and was
  published by run `32661406111`; it was later superseded by `v0.2.58` below.
- Linux Node 20/24 pack/global-install smoke passed. The real mac-office Node 20 functional
  smoke passed; its old GitHub cache-save post-step hung and the run was stopped. The cache
  was removed from the self-hosted workflow because its local pnpm store is already persistent.
- The corrected main workflow subsequently passed its normal Linux CLI smoke in run
  `32661785753`; the Windows hosted matrix remains the explicitly listed external limitation.
- mac-office was restarted immediately after the server deploy, then upgraded again. The
  later public-positioning release published `very-happy-cli@0.2.58` from tag `v0.2.58`
  (publish run `32663659805`; Linux Node 20/24 and mac-office Node 20/24 smoke run
  `32663659807`). The running daemon reports **0.2.58**.
- Production auth capacity at verification time: open signup, maximum 100 accounts,
  6 registered, 94 remaining.

## Blocking historical findings

A final current-tree `git archive HEAD` scan covered about 16.2 MB and returned **0 findings**.
A full-history scan covered 2,537 commits / about 33.85 MB and returned **45 findings** across
14 commits and 13 paths: 7 GCP API key, 30 generic API key, and 8 JWT detections.

The most serious object is a deleted upstream real-session JSONL containing tokens and user
content. Historical Google/Firebase configuration and old environment/deployment files also
need explicit disposition. At minimum, build the rewrite manifest from the scanner report and
these known paths:

```text
android/app/google-services.json
expo-app/google-services.json
google-services.json
cli/explore-claude-cli/v1-real-sessions-by-kirill-from-handy-cli/example-sessions/*.jsonl
sources/sync/__testdata__/log_0.json
packages/happy-server/.env.dev
packages/happy-cli/.env.dev
packages/happy-cli/.env.dev-local-server
packages/happy-cli/.env.integration-test
packages/happy-server/deploy/overlays/local/secrets.yaml
packages/happy-cli/src/claude/utils/__fixtures__/*.jsonl
```

Some scanner hits are test vectors or public mobile configuration, but they must be reviewed
and allowlisted only after the real session/token objects are removed. Treat every historical
credential as exposed until its owner confirms restriction, revocation, or rotation.

## Owner-only public switch procedure

These operations are intentionally not performed by this release-candidate work:

1. Freeze pushes and tags. Create an offline mirror/bundle backup and record current ref→SHA
   mappings. Keep that backup private.
2. In a disposable isolated mirror, create a reviewed `git filter-repo` path/callback manifest
   from the complete redacted gitleaks JSON plus the known paths above. Remove session dumps,
   environment/secrets files, and sensitive blobs from **all refs**, including tags.
3. Run gitleaks across every rewritten ref and inspect packfiles for the known tokens/paths.
   The acceptance result is zero unreviewed findings—not merely a clean default branch.
4. Revoke historical login/session tokens. Rotate any still-valid private credential and
   restrict Firebase/GCP browser keys by API, origin/bundle identifier, and quota as applicable.
5. Prefer pushing the rewritten result to a new private staging remote. Otherwise schedule an
   Owner-approved maintenance window for the shared-history replacement. Require every
   collaborator and runner checkout to re-clone; never merge the old history back.
6. On the staging remote, enable branch protection/rulesets, read-only default Actions
   permissions, secret scanning/push protection, Dependabot, and required Quality Gates.
   Open a fork PR and prove that all code jobs use GitHub-hosted runners and receive no
   production/publish secrets.
7. Recheck LICENSE/upstream attribution, public contact/security-reporting route, OAuth consent
   branding/origins, and Cloud account cap. Then—and only then—change visibility to public.

Recommended order: **history rewrite → credential/session invalidation → all-ref scan → new
private staging remote → fork-PR isolation drill → Owner production acceptance → public switch**.

## Known non-blocking limitations

- The server image still runs as root and is 1.55 GB. Reducing privileges and image size is a
  worthwhile defense-in-depth follow-up, not an unaddressed release P1.
- The PostgreSQL smoke service uses a major-version tag; the shipping Node base is digest-pinned.
- PGlite migration SQL and its migration marker have a narrow crash window between operations.
- Failed/abandoned attachment reservations remain charged to quota by design (fail closed).
- Windows CLI postinstall is not currently exercised because private-repository hosted billing
  prevents that job from starting. Linux 20/24 and real macOS coverage are green; run the
  Windows matrix once hosted capacity is available or after the repository becomes public.
- GitHub emits Node 20 action-runtime deprecation warnings; pinned actions currently run under
  the runner's Node 24 compatibility mode and complete successfully.

## Final decision

**NOT READY for public visibility solely because the Owner-only Git history cleanup and
credential/session response have not been executed.** The current source tree, product flow,
documentation, self-host distribution, deployed service, and CLI release are otherwise an
open-source release candidate with no known in-scope P0/P1.
