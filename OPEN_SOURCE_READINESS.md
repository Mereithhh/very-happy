# Open-source readiness

> Assessment date: 2026-08-24 (Asia/Singapore)
> Candidate branch: `main`
> Released Web source: `6706fc8e78a2b043209c059aefae543701c847ef`
> Released Server source: `5cf786e6bbbaaa76428c7480fba2789bbc2f23c7`
> Production CLI: `very-happy-cli@0.2.61` (`v0.2.61`)
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
  title sheen, pointer-responsive 3D depth, dual orbits, scanning planes, data beams, packets,
  and live telemetry surround the real interactive workspace. Floating machine identity badges
  were removed completely; mobile keeps the motion system without CTA collisions or overflow,
  while reduced-motion users receive a complete static composition.
- Landing and Docs now include an explicit mobile continuity proof built from two authentic,
  interactive phone-width product surfaces: a raw Claude terminal and its structured mirror.
  The real conversation control and `Back to terminal` path work in both directions; the animated
  handoff labels the optional Claude-hook boundary without claiming the sanitized demo is live.
- The fork's central interaction difference is now visible in the first Hero viewport and then
  explained as two unambiguous branches: SDK-backed Claude produces a structured session, while
  a tmux-owned process preserves the real agent TTY/TUI and can optionally expose a Claude mirror.
  Public copy also states the real downgrade boundary: durable terminals require tmux, the mirror
  requires tmux 3.2 or newer, and no-tmux/Windows uses a non-persistent direct-shell fallback.
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
  upgrades/rollback, troubleshooting, contributing, and a platform-accurate keyboard/touch
  reference.
- Landing and Docs now demonstrate the production command-palette surface rather than a
  marketing facsimile. The real Product Preview Search control and an explicit touch CTA open
  a sanitized local palette for actions, chats, and terminals; Arrow navigation exposes a
  complete combobox/listbox active-selection chain. Public pages deliberately do not hijack
  the browser's global `Command/Ctrl+K`.
- Public docs now share the landing's editorial Console system and the same interactive product
  proof, group the guide set by user intent, provide desktop on-page navigation and an accessible
  mobile chapter menu.
- Coarse-pointer form controls and editable surfaces have a global 16 px floor across the app
  and body portals, preventing iOS focus zoom. The xterm subtree is structurally excluded so
  hidden textarea, cursor, and IME cell metrics stay unchanged.
- Mobile browsers now receive a proactive, device-local Web App install region in both the
  anonymous and authenticated roots. Android/Chromium invokes the browser-owned install prompt
  only from a user gesture; iPhone/iPad and unsupported browsers receive accurate Share/menu
  instructions. Standalone, accepted, and seven-day dismissal states suppress repeat prompts;
  active form editing defers the non-modal panel instead of stealing focus.
- A real but scrubbed Tanka field note demonstrates the generic IM-to-session loop without
  publishing private infrastructure. It explicitly separates that adapter from the shipped
  Claude coordinator and future provider gateway. The public adapter example now fails closed
  on sender/chat authorization, fixed workspace mappings, deduplication, and rate limits.
- Password and Google signup/login, capacity states, network/authentication errors,
  terminal approval, first-machine recovery, and CLI commands form one coherent journey.
- First connection now makes the detached `very-happy daemon start` step explicit in the
  authenticated First Run screen, landing, public docs, and READMEs. The CLI goes directly to
  Web approval, removes the nonexistent native-mobile/QR path, and prints daemon startup as the
  next action after both fresh and existing authentication.
- Installation and configuration now distinguish required Node support, Claude SDK credential
  sources, optional external agent commands, and tmux. `doctor` and daemon state report only a
  non-secret credential category; the docs explain service-manager environment persistence and
  make the no-tmux direct-shell/non-durable downgrade explicit.
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
`908ef015` pairing/onboarding follow-up repeated the affected Web and CLI gates locally and in
the exact-SHA clean Actions checkout:

| Surface | Evidence |
|---|---|
| Web V2 | 103 test files / 1,453 tests; Vite production build; TypeScript 0 errors |
| CLI | 122 test files / 1,209 tests locally; build; isolated `HAPPY_HOME_DIR`; runtime reports 0.2.61 |
| Server | 53 test files / 387 tests; TypeScript 0 errors |
| Wire / Agent | Wire 2 files / 19 tests; Agent 9 files / 229 tests, both build cleanly |
| CI | Final Quality Gates `32733166641` passed for exact deployed Web source `6706fc8e`; Server Quality Gates `32725836378` passed for source `5cf786e6`; tag CLI smoke `32724248408` passed on Linux and mac-office Node 20/24 at CLI tag source `86e56c8e`; setup/action pins resolve to immutable commits |
| Dependencies | `pnpm audit --prod`: 0 known vulnerabilities |

Server and CLI tarballs were installed into isolated locations. The server tarball migrated
an empty PGlite database through 42 migrations. The CLI tarball executed its postinstall and
runtime/version smoke without relying on workspace packages.

A detached clean checkout at `4c259d86` downloaded all dependencies from an empty worktree and
passed the Wire, Server, Web, CLI, and Agent gates above. The final server-only compatibility
follow-up then passed its exact-SHA CI gate. A final CLI tarball was installed on `sd-dev` into
an isolated prefix and HOME: Node 22.19, CLI 0.2.61, HOME mode 0700, tmux 3.2a, zero
native/mobile-app auth mentions, and the new first-use doctor output all passed. Earlier in the
same isolated-new-user run, signup, secure pairing, daemon connection, machine visibility,
tmux terminal/file preview (`VERY_HAPPY_SDDEV_OK`), and the no-tmux direct shell
(`NO_TMUX_OK`) completed end to end. Only the test-owned temporary daemon/server processes were
stopped afterward; the pre-existing global daemon was preserved.

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

- production landing and all 13 documentation chapters render with no horizontal overflow;
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
- after the mobile-continuity release, fresh production 1440x1000 and 390x844 tabs confirmed
  both phone-width production surfaces, the real terminal → structured mirror → terminal loop,
  animated desktop and vertical-mobile handoff states, SOURCE/MIRROR demo labels, no horizontal
  overflow, 16 px visible mobile inputs, and duplicate-ID-free reuse on the Docs index.
- after the dual-path release, an initially stale service-worker load was rejected as mixed-version
  evidence; two hard reloads then confirmed the deployed `index-DncsBc_n-202608240703.js`. Fresh
  390x844 and 1440x1000 checks found the Hero thesis in the first mobile viewport, the corrected
  two-branch rail, real bidirectional terminal/mirror controls, 16 px mobile input, no horizontal
  overflow or console warnings. `/docs/architecture` exposed the tmux 3.2 and direct-shell fallback
  boundaries at 390 px without overflow.
- after the final candidate deploy, a fresh isolated production profile opened `/welcome`,
  clicked the authentic file control inside the animated Hero, and confirmed no desktop
  overflow. At 390x844, the Claude-credential docs anchor rendered without overflow and login
  inputs computed to 16 px. The exact deployed asset was
  `/assets/index-DqO_Dc10-202608241151.js`; console error output was empty.
- after the keyboard-first workflow release, production `/welcome` at 390x844 exposed the
  production-style palette as a 16 px combobox with zero page overflow. The explicit Try CTA
  focused it; ArrowDown moved `aria-activedescendant` and the sole `aria-selected` option from
  New terminal to New chat; an anonymous `Command+K` remained unprevented and did not steal
  focus. At 1440x1000, the authentic Product Preview Search control summoned and focused the
  same surface. `/docs/keyboard` rendered its Windows/Linux input boundary without overflow,
  and both routes produced zero console errors or warnings.

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

The SDK/tmux dual-path follow-up received separate public-security and first-user/UX reviews.
They found and closed unconditional tmux/mirror claims, the missing tmux 3.2 and no-tmux fallback
boundary, a visually reversed path-to-phone mapping, a late Hero value proposition, adversarial
upstream wording, and a README technical wall before the product image. Both freeze rereviews
ended at **P0=0, P1=0, P2=0**.

The pairing/onboarding follow-up received independent security/CLI and first-user/docs reviews.
They found and closed an unreachable post-daemon First Run card, headless-browser wording,
undersized command copy targets, stale mobile/QR documentation, and a source-only authentication
test. The final behavior test executes secure pairing create/poll, verifies the claim secret stays
out of the approval URL, and proves the v3 gate fails closed. Both freeze rereviews ended at
**P0=0, P1=0, P2=0**.

The final public-repository security freeze covered authentication/OAuth, pairing, socket and
cross-account ownership, terminal/file relay limits, all persistent growth surfaces, upload
object existence and cleanup, log sanitization, local file permissions, and PR/release isolation.
The reviewer ended at **P0=0, P1=0, P2=0** for the current tree. A separate first-user/UI/docs
review found and closed the missing Claude credential setup and misleading OpenClaw setup copy.

The mobile PWA-install follow-up received independent public-security and first-user/mobile-UX
reviews. Security ended at **P0=0, P1=0, P2=0**. UX found one P2—non-modal behavior paired with
dialog semantics and no focus policy—which was fixed by switching to a polite region and
deferring while an editable control is active; the freeze rereview ended at
**P0=0, P1=0, P2=0**.

The keyboard-first workflow follow-up received independent public-security/code and
first-user/UX/mobile reviews. They found and closed anonymous global-key interception,
screen-reader active-selection gaps, over-broad IME and Windows/Linux `Ctrl+N` claims, and
decorative misuse of the live/focus accent token. Both freeze rereviews rebuilt or exercised
the public surface and ended at **P0=0, P1=0, P2=0**.

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
- The explicit mobile terminal/conversation continuity proof shipped Web-only from SHA
  `65d4477cb9af7445352dbcffc89dd1a071f7de1f`. Exact-SHA Quality Gates run `32697747972`
  and deploy run `32697897214` passed, producing
  `/assets/index-BPPpJFqz-202608240635.js`. Production health, hashed asset delivery,
  Landing/Docs reuse, desktop/mobile layout, real bidirectional controls, 16 px input sizing,
  and zero horizontal overflow were verified afterward. The atomic Web rollback is the prior
  `9b64f5e2` Hero build.
- The structured/native-terminal positioning shipped Web-only from SHA
  `25a71f0dffa26836a543d17fa62312f28ad779a0`. Exact-SHA Quality Gates run `32699631101`
  and deploy run `32699821060` passed, producing
  `/assets/index-DncsBc_n-202608240703.js`. Production health/MIME, 390x844 and 1440x1000
  Landing, mobile architecture docs, first-viewport thesis, corrected path rail, real terminal ↔
  mirror controls, 16 px input, zero overflow, and clean console all passed. The atomic Web
  rollback is the preceding `65d4477c` mobile-continuity build.
- The complete pairing/daemon onboarding shipped from SHA
  `908ef0151c15cb1d61eda02aa669b27cc6e79541`. Exact-SHA Quality Gates run
  `32702080377` and Web deploy run `32702298861` passed, producing
  `/assets/index-DerkVnxJ-202608240737.js`. After the expected Service Worker update/hard
  refresh, production `/welcome` showed all five steps and `/docs/quickstart` showed daemon as
  step 4 and the first session as step 5; 390x844 and 1440px checks had no overflow, mobile
  inputs remained 16 px, JavaScript MIME and health passed, and the console was clean. The Web
  rollback is the preceding `25a71f0d` build in `/opt/happy/webapp.prev`.
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
- The pairing follow-up published `very-happy-cli@0.2.60` from tag `v0.2.60` (publish run
  `32702470661`; Linux and mac-office Node 20/24 smoke run `32702470738`). The published
  tarball and then the standard registry spec both installed into isolated prefix/HOME
  directories and passed version/auth-help runtime smoke. `vh-update` completed on mac-office;
  the running daemon reports **0.2.60**. Rollback is `very-happy-cli@0.2.59`.
- The final candidate deployed Server then Web from
  `86e56c8e3c15ad6c1d5cb2eac3824533c4b15caa` in run `32724008762`, after Quality
  Gates `32723809686`. The first deploy attempt (`32723491921`) exposed a legacy-container
  bind-host incompatibility; production was immediately restored to `d3d50d68`, the mechanism
  received a regression test, and the exact-SHA redeploy then passed. Health, auth capacity,
  hashed-JavaScript MIME/cache, desktop/mobile browser acceptance, and the required post-server
  daemon restart passed. CLI `v0.2.61` was published by run `32724248409`; tag smoke
  `32724248408` passed on Linux and mac-office Node 20/24. Rollback is source `d3d50d68` and
  CLI `0.2.60`.
- Restarting the production 0.2.61 daemon then exposed a second release-only regression: its
  normal multi-session idempotent replay was charged before duplicate detection, exhausting the
  new 600-message/minute account budget and producing a 429 retry storm. Server source was
  immediately rolled back and the daemon reconnected cleanly. The fix charges only rows that
  will actually be inserted, with three repeated localId retries pinned as zero rate cost.
  Full Server tests (53 files / 387 tests), exact-SHA Quality Gates `32725836378`, and the
  Server-only deploy `32726043403` passed. After the required daemon restart, mac-office 0.2.61
  connected without 429/retry errors, `/health` and `/v1/auth/config` returned 200, and the
  account cap remained open/100 with 94 slots available.
- The mobile PWA install experience and Hero-node removal shipped Web-only from
  `ba6a6a0731efa29f5261cfc5eadee54ebcff5221`. Exact-SHA Quality Gates
  `32728718900` and deploy run `32728759820` passed, producing
  `/assets/index-BwhDJXbc-202608241245.js`. Health, JavaScript MIME/cache, manifest icons/scope,
  no-store Service Worker delivery, and a real 390x844 production browser passed. The first
  browser load correctly demonstrated the expected old-SW state; after auto-update and reload,
  the install region appeared, floating Hero nodes were zero, editable controls remained 16 px,
  and horizontal overflow remained zero. The atomic Web rollback is the preceding
  `86e56c8e` Web deployment in `/opt/happy/webapp.prev`.
- The keyboard-first workflow and formal keyboard/touch guide shipped Web-only from
  `6706fc8e78a2b043209c059aefae543701c847ef`. Exact-SHA Quality Gates run
  `32733166641` and deploy run `32733390947` passed, producing
  `/assets/index-DOk__bqF-202608241333.js`. Health, JavaScript/CSS MIME, desktop Product
  Preview Search, 390x844 command-palette interaction and accessibility state, Docs boundary
  copy, 16 px input sizing, zero overflow, and clean consoles passed. The atomic Web rollback
  is the preceding `ba6a6a07` deployment in `/opt/happy/webapp.prev`.
- Production auth capacity at verification time: open signup, maximum 100 accounts,
  6 registered, 94 remaining.

## Blocking historical findings

A final current-tree `git archive HEAD` scan processed 16.69 MB and returned **0 findings**.
A full-history scan covered 2,572 commits / about 34.75 MB and returned **45 findings** across
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
- Abandoned upload reservations are reclaimed after their TTL; completed uploads are never
  TTL-cleaned, and completion requires the local/S3 object to exist.
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
