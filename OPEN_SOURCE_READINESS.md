# Open-source readiness

> Assessment date: 2026-08-24 (Asia/Singapore)
> Candidate branch: `main`
> Released product source: `9b64f5e27432f185162297d29c90815903283cf6`
> Production CLI: `very-happy-cli@0.2.59` (`v0.2.59`)
> Decision: **NOT READY to change repository visibility yet**

The application and deployment candidate are ready for Owner acceptance. There are no
known code, product, documentation, or current-tree P0/P1 issues in the frozen scope.
The sole public-release blocker is historical: the existing Git object database contains
credentials and real session material. A normal commit cannot remove it, and the Owner
explicitly reserved history rewriting and credential rotation. Do not make this repository
public until the procedure below is complete.

## What is complete

- A responsive public landing page explains the product, capabilities, first connection,
  Cloud versus self-hosting, upstream origin, and the real trust boundary. Its interactive,
  privacy-safe product proof uses the authenticated app's production component style contracts
  for the session sidebar, terminal, file browser, structured conversation, and board,
  with sanitized fixture data and no auth/sync/socket imports in the anonymous bundle.
- The landing also has a canonical `/welcome` route that is independent of login state while
  `/` preserves the existing contract (anonymous visitors see the landing; returning users enter
  the workspace). Docs, legal pages, and the README return to that stable marketing route.
- Product proof navigation now happens inside the authentic UI instead of a tall marketing scene
  selector. Sidebar board/session controls, Back, structured mirror, Files, and board cards form a
  complete desktop/mobile loop; controls that cannot be safely simulated are visibly disabled.
- The Hero now treats high-impact motion as product storytelling rather than background garnish:
  title sheen, pointer-responsive 3D depth, machine/agent nodes, dual orbits, scanning planes,
  data beams, packets, and live telemetry surround the real interactive workspace. Mobile keeps
  the foreground machine layer without CTA collisions or overflow, while reduced-motion users
  receive a complete static composition.
- Core claims now have matching interactive product surfaces: a production-style Claude
  meta-agent/optional-voice view and the current machine/path/agent launcher for Claude, Codex,
  Gemini (ACP beta), and OpenClaw. The demos are explicitly local and disconnected; Pi,
  automatic cross-provider routing, and the virtual office remain labelled roadmap.
- Public positioning now owns a broader agent-workspace category: “Work anywhere. Keep the
  thread.” It distinguishes current Claude/Codex/ACP capabilities from Pi/provider-gateway
  roadmap and the long-term virtual-office concept, and states the Claude/voice prerequisites
  for the optional meta-agent.
- ACP is now described at its implemented boundary: a beta Agent Client Protocol backend using
  the official SDK, Gemini/OpenCode presets, and a generic compatible stdio runner. Public docs
  explicitly distinguish it from the unrelated historical Agent Communication Protocol that
  shares the acronym, and do not imply provider parity.
- Public Web docs cover quick start, CLI/daemon, Cloud, self-hosting, configuration,
  architecture/data flow, integrations/automation, security/privacy, accounts/quotas,
  upgrades/rollback, troubleshooting, and contributing.
- Public docs now share the landing's editorial Console system and the same interactive product
  proof, group the guide set by user intent, provide desktop on-page navigation and an accessible
  mobile chapter menu.
- Coarse-pointer form controls and editable surfaces have a global 16 px floor across the app
  and body portals, preventing iOS focus zoom. The xterm subtree is structurally excluded so
  hidden textarea, cursor, and IME cell metrics stay unchanged.
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
- Optional terminal-mirror installation is documented consistently across landing, docs,
  README, and CLI help. Installation/removal preserves foreign Claude hooks even when another
  tool shares the same matcher entry; mixed-entry install/remove regressions are covered.

## Verification evidence

### Clean checkout and package gates

A no-hardlink clone and a second detached worktree at product base `8b1e202a` both completed
`pnpm install --frozen-lockfile`. The latter started without workspace build outputs and ran
wire build plus the full affected-package gates and isolated CLI runtime smoke. The final
`9b64f5e2` 3D Hero follow-up repeated the affected Web gates locally and in the
exact-SHA clean Actions checkout:

| Surface | Evidence |
|---|---|
| Web V2 | 99 test files / 1,424 tests; Vite production build; TypeScript 0 errors |
| CLI | 106 test files / 1,150 tests; build; isolated `HAPPY_HOME_DIR`; published runtime reports 0.2.59 |
| Server | 34 test files / 281 tests; TypeScript 0 errors |
| CI | Final Quality Gates `32696115677` passed for exact deployed source `9b64f5e2`; Linux CLI smoke `32690257926` passed for released CLI source `8b1e202a`; setup/action pins resolve to immutable commits |
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
- the redesigned production landing and docs were rechecked at 390x844 and 1440px in light
  and dark themes; the current UI no longer exposes marketing scene tabs, and its sidebar,
  conversation, terminal, files, and board controls complete the preview flow;
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
- after the final Web deploy, a new isolated production profile confirmed zero horizontal
  overflow on landing/docs/quickstart, working native-view navigation, no
  AppRoot/crypto fetch, stable docs focus styling, and the mobile signup route. The existing
  authenticated production browser still resolved `/` to the app rather than the public hero.
- the final animated hero was verified again in a service-worker-cleared production profile at
  1440x1000 and 390x844: the real shared terminal/file product surface starts inside the first
  viewport, its two preview instances have unique ARIA IDs and local keyboard focus, mobile file
  overlay stays contained, landing/docs have zero horizontal overflow, and the console is clean.
- after the `8b1e202a` deploy, a fresh service-worker-cleared production profile re-ran the
  complete public proof in light and dark themes: terminal + real file preview, structured
  Claude mirror and local-only input, three-column task board, voice meta-agent, and agent
  launcher all responded. At 390x844 every visible input/select/textarea computed to 16 px,
  the full-screen file layer took first focus and hid the underlying terminal from the AX tree,
  landing/docs stayed at `scrollWidth === innerWidth`, and no console errors were recorded.
- after the `/welcome` release, a fresh service-worker-cleared production profile confirmed
  anonymous and stored-credential hard reloads both render the landing at `/welcome` without
  loading AppRoot, crypto, xterm, or terminal chunks. A second path loaded Docs through AppRoot
  and returned to `/welcome` by client navigation. At 390x844 there was no horizontal overflow,
  every visible input/select/textarea computed to 16 px, and both public-root console logs were
  empty. Production GET returned `200 text/html` and the new hashed entry asset served as
  JavaScript.
- after the complex 3D Hero release, fresh production tabs at 1440x1000 and 390x844 confirmed
  the title sheen, floating workspace, rotating agent orbit, visible foreground machine nodes,
  and authentic session-list interaction. The mobile pass found and closed a real 3D stacking
  regression before final deployment; the rereun showed no CTA collision or horizontal overflow,
  no marketing tablist, and every visible input/select/textarea at 16 px.

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

The public-experience redesign received two further independent passes. The UX/first-user pass
closed the fake-product-demo, Claude-first positioning, onboarding order, dead control, docs
focus, target-size, and accent-discipline findings. The security/code pass found three obsolete
screenshots containing Owner/machine identifiers; all three were removed from the current tree,
the replacement was confirmed synthetic and metadata-free, and every ARIA/control finding was
fixed. Both passes ended with P0=0 and P1=0 for the current tree.

The high-motion real-product hero and ACP calibration received final independent security and
first-user/UI passes. They closed misleading static-live labels, excessive decorative loops,
incomplete reduced-motion hover handling, late product evidence, duplicate preview IDs/focus
scope, and nested landmarks. Both rereviews ended at P0=0, P1=0, P2=0; anonymous routes still
exclude auth/sync/crypto/xterm runtime code and the ACP beta claims match the shipped SDK/routes.

The final core-feature proof received another independent UX/browser/accessibility pass and a
separate public-change/security pass. They found and closed the mobile cold-overlay focus leak,
IME re-entry gap, voice/PTT timing and semantics issues, duplicate IDs, inaccurate OpenClaw/ACP
wording, and a mixed Claude-hook matcher case that could delete another tool's command. Both
final rereviews signed **P0=0, P1=0, P2=0**. The security pass also rebuilt the anonymous
dependency closure and confirmed it excludes AppRoot, crypto, xterm, auth, sync, socket, RPC,
media capture, internal hosts, and secret needles.

The canonical marketing-route follow-up received an independent routing/bundle review. It found
and closed one P2: Privacy/Terms branding still pointed to login rather than the marketing page.
The rereview verified direct reloads, AppRoot/PublicRoot client navigation, `/v2/` basename
handling, Docs/legal return links, scroll reset, and the anonymous dependency boundary, ending
at **P0=0, P1=0, P2=0, P3=0** for the change.

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
- The redesigned landing/docs, privacy-safe workspace image, and mobile 16 px form floor were
  Web-only deployed from SHA `de7f57137886e29355ace209e1111551b40d3e17` by run
  `32681554681` after exact-SHA Quality Gates run `32681433783` passed. Health returned 200,
  the versioned main asset served as JavaScript, anonymous 390px/1440px browser checks passed,
  and the existing authenticated root remained in the application.
- The final product proof now reuses the authenticated app's production sidebar, terminal,
  file viewer, conversation, board, and Console-token style contracts with sanitized static
  data; landing and docs share the same component. It was Web-only deployed from SHA
  `891efb65863f39fd6b9c29186365e727605fa28d` by run `32683404930` after exact-SHA Quality
  Gates run `32683266145` passed. An isolated production browser verified the versioned asset
  `/assets/index-BeqkYBBQ-202608240233.js`, all three views and return-to-terminal behavior,
  contained mobile file overlay, all three mobile board columns, landing/docs zero horizontal
  overflow at 390 px and 1440 px, and the server health endpoint.
- The direct real-product Hero, branded background motion, polished docs surfaces, and ACP
  wording correction were Web-only deployed from SHA
  `8cf00c1c9abdefd0f6be9ce7a8fcc43af57657b0` by run `32685602020` after exact-SHA Quality
  Gates run `32685426507` passed. Post-deploy health returned OK and the new entry asset
  `/assets/index-D8V1cLwX-202608240312.js` served as JavaScript; isolated desktop/mobile browser
  acceptance and the real preview interactions passed without console errors.
- The final authentic core-feature surfaces, mobile overlay/focus fixes, terminal-mirror truth,
  and foreign-hook preservation shipped from SHA
  `8b1e202ac05f14d0a1c02e555a0327d4bc805257`. Exact-SHA Quality Gates run `32690257874`
  and main Linux CLI smoke run `32690257926` passed; Web-only deploy run `32690431876`
  produced `/assets/index-DzMe0JXM-202608240433.js`. Post-deploy health/MIME checks and fresh
  1440x1000 plus 390x844 browser acceptance passed.
- The stable login-independent marketing route shipped from SHA
  `171575c5a9fc5f3e30ba0f2eea1254e2c079407f`. Exact-SHA Quality Gates run `32692043448`
  and Web-only deploy run `32692163926` passed, producing
  `/assets/index-Dq-I-uet-202608240503.js`. Production health, GET `/welcome`, JavaScript MIME,
  anonymous/stored-credential hard reloads, AppRoot client navigation, 390x844 layout, 16 px
  controls, and public-root console checks passed. Rollback remains the atomic
  `/opt/happy/webapp.prev` deployment from `8b1e202a`.
- The native-control product-proof refinement shipped Web-only from SHA
  `3f23fce99ca696ab3d119428e880120f40e15259`. Exact-SHA Quality Gates run `32693831075`
  and deploy run `32693972468` passed, producing
  `/assets/index-LWzg52cV-202608240534.js`. A fresh production 390x844 browser confirmed no
  marketing tablist, sidebar → board → session → file navigation through authentic controls,
  16 px visible form controls, no horizontal overflow, and no console errors. Rollback remains
  the prior `171575c5` atomic Web deployment.
- The complex 3D agent-fabric Hero shipped Web-only from final SHA
  `9b64f5e27432f185162297d29c90815903283cf6`. Exact-SHA Quality Gates run `32696115677`
  and deploy run `32696263872` passed, producing
  `/assets/index-CUQkyOg--202608240611.js`. Production health and JavaScript/CSS MIME checks
  passed; fresh 1440x1000 and 390x844 browser runs verified motion, authentic preview controls,
  foreground node layering, no CTA collision or horizontal overflow, and 16 px mobile controls.
  The atomic Web rollback is the preceding `aaee6036` build; `3f23fce9` remains the pre-Hero
  fallback.
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
  final release published `very-happy-cli@0.2.59` from tag `v0.2.59` (publish run
  `32690525269`; Linux Node 20/24 and mac-office Node 20/24 smoke run `32690525236`). A
  separate registry install into an isolated prefix/HOME passed version and non-mutating hook
  help smoke. `vh-update` completed and the running daemon reports **0.2.59** with a current
  heartbeat. Rollback remains `very-happy-cli@0.2.58`.
- Production auth capacity at verification time: open signup, maximum 100 accounts,
  6 registered, 94 remaining.

## Blocking historical findings

A final current-tree `git archive HEAD` scan processed 16.36 MB and returned **0 findings**.
A full-history scan covered 2,551 commits / about 34.10 MB and returned **45 findings** across
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
- Most public-UI unit regressions are source/contract tests rather than a permanent browser CI
  suite. This release compensates with independent real-browser desktop/mobile acceptance;
  converting those checks into maintained browser CI is a P3 follow-up.
- SPA deep links are served for browser `GET` navigation, but the existing fallback rejects bare
  `HEAD` requests with 404. Health and hashed-asset probes support their documented methods;
  generic link monitors should use GET until HEAD parity is implemented.

## Final decision

**NOT READY for public visibility solely because the Owner-only Git history cleanup and
credential/session response have not been executed.** The current source tree, product flow,
documentation, self-host distribution, deployed service, and CLI release are otherwise an
open-source release candidate with no known in-scope P0/P1/P2.
