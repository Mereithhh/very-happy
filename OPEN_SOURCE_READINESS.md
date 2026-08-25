# Open-source readiness

> Assessment date: 2026-08-25 (Asia/Singapore)
> Candidate branch: `main`
> E2EE deferral revert: `e1c2b9902a6449284abcb9e821d9fb20a0a8a865`
> Released Web source: `a01d1c76e67a8ba4a8ad9fcf9bd98637e9300e07`
> Released Server source: `2300f4ab335c105a92d281806c955b7e44d8854a`
> Production CLI: `very-happy-cli@0.2.64` (`v0.2.64`)
> Decision: **NOT READY to change repository visibility yet**

The application and deployment candidate are ready for Owner acceptance. There are no
known code, product, documentation, or current-tree P0/P1/P2 issues in the frozen scope.
The remaining public-release blockers are Owner-controlled release-governance actions: rewrite
and rescan the Git history, invalidate exposed credentials/session material, configure the
public-repository protections and prove fork-PR isolation, verify external OAuth/Cloud policy,
and give final production acceptance. A normal commit cannot complete those actions, and the
Owner explicitly reserved the irreversible ones. Do not make this repository public until the
procedure below is complete.

## What is complete

- A responsive public landing page explains the product, capabilities, first connection,
  Cloud versus self-hosting, upstream origin, and the real trust boundary. Its interactive,
  privacy-safe product proof uses the authenticated app's production component style contracts
  for the session sidebar, terminal, file browser, structured conversation, and board,
  with sanitized fixture data and no auth/sync/socket imports in the anonymous bundle.
- The public product hierarchy is now explicitly Web-first: the browser or installable PWA is
  the recommended daily workspace, while the CLI and background daemon are the required
  machine-side bridge for pairing, diagnostics, automation, and local recovery. The first-use
  path still installs the CLI and starts the daemon; it no longer presents the CLI as the
  primary place users should spend their day.
- The product is now positioned and rendered as an account-level command panel for many
  connected machines and agents. The production sidebar itself—not only the marketing fixture—
  shows `machine · agent · path` for structured sessions and `machine · terminal` for native
  TTY sessions. The Hero, sanitized interactive preview, README, social metadata, and architecture
  diagrams use the same information model. Public copy states that dispatch is explicit today:
  the user chooses the machine and agent; automatic cross-machine/provider routing remains roadmap.
- The Hero's primary proof is now an interactive scheduler topology rather than another workspace
  screenshot. Visitors can select a personal computer, remote server, or generic runtime and then
  Claude Code, Codex, OpenCode ACP beta, or any text TUI; only that explicit machine/agent route is
  animated. The center shows the actual `Web/PWA ⇄ trusted relay ⇄ CLI daemon` chain. API/webhooks,
  runner-specific MCP tools, and the optional Claude-only Meta Agent are separate inspectable
  boundaries, not interchangeable routes. The authentic production-style fleet workspace remains
  immediately below the Hero as evidence for the conceptual map.
- The terminal story is agent-independent. A tmux-owned real TTY preserves ordinary
  `xterm-256color` text shells and TUIs—not only coding agents—while the Web supplies durable
  access, files, tasks, and structured Claude continuity. Public copy does not promise support
  for terminal graphics protocols such as sixel or Kitty graphics.
- MCP positioning now follows the shipped implementation exactly: managed Claude runners can
  change titles, copy text, open file previews, and report progress; Codex, Gemini, and the ACP
  bridge expose the common title/clipboard/preview subset; the optional meta-agent adds a
  separate high-privilege local control surface. The docs disclose that user-scoped Claude MCP
  registration affects every Claude session for that operating-system user and requires the
  local daemon.
- The landing also has a canonical `/welcome` route that is independent of login state while
  `/` preserves the existing contract (anonymous visitors see the landing; returning users enter
  the workspace). Docs, legal pages, and the README return to that stable marketing route.
- GitHub now has a deliberate second landing page rather than a technical wall: a native animated
  SVG Hero with reduced-motion support, the real sanitized workspace image, Cloud/self-host and
  trust CTAs, structured-versus-real-TUI positioning, mobile/PWA and keyboard proof, an accurate
  shipped/Beta/roadmap agent matrix, upstream attribution, and the “You get to be Very Happy”
  brand promise. Every local README target and the remote GitHub bytes were verified.
- The Cloud quick start now includes a version-controlled `/install.sh`. The copyable compound
  command downloads the complete script into `mktemp` before execution and cleans it with a trap;
  the script validates Node and CPU support, resolves and verifies one exact npm version, runs
  doctor, Web approval, and `daemon start`, and fails closed on mismatched or non-HTTPS custom
  endpoints. Offline dry-run and skipped-step endings are truthful; sudo, tmux installation,
  provider credential writes, and optional Claude hooks remain explicit non-goals.
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
- Coarse-pointer and phone-width form controls have a global 16 px floor across the app and
  body portals, preventing iOS focus zoom. Terminal-owned fields are handled separately: the
  current overlay derives a 16 px-safe metric without changing desktop policy, and the legacy
  hidden xterm helper receives a narrow-screen font floor while its inline cell geometry,
  visible composition view, cursor, rows, and columns remain unchanged.
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
- Doctor process listings and cleanup no longer echo arbitrary argv. Startup environment logging
  now carries only configured/enabled flags plus bounded runtime categories—never raw argv,
  usernames, HOME/PWD, local paths, DEBUG values, or custom URLs—closing the local and optional
  remote-debug disclosure path for generic ACP arguments.
- Public language consistently says **server-trusted, not end-to-end encrypted**. It does
  not promise zero knowledge, operator blindness, durability, SLA, or undeletable data.
- Fork PR code is confined to GitHub-hosted runners with read-only contents permission.
  Deploy and npm publish workflows do not accept PR triggers.
- GitHub Actions now has repository-enforced immutable SHA pinning; the static CI contract
  rejects every unpinned external action or container digest. Default workflow permissions stay
  read-only and Actions cannot approve pull requests. Vulnerability alerts and Dependabot
  automated security fixes are enabled on the private source repository.
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
| Web V2 | 109 test files / 1,477 tests; Vite production build; TypeScript 0 errors |
| CLI | 123 test files / 1,211 tests locally; build; isolated `HAPPY_HOME_DIR`; published runtime reports 0.2.64 |
| Server | 57 test files / 408 tests; TypeScript 0 errors; production runtime build passed |
| Wire / Agent | Wire 2 files / 19 tests; Agent 9 files / 229 tests, both build cleanly |
| CI | Final fleet-panel Quality Gates `32767214395` passed at exact release SHA `bb04a436`; Server lock gate `32757748151` passed at `2300f4ab`; tag CLI smoke `32749236740` passed on Linux and macOS Node 20/24 at `v0.2.64`; setup/action pins resolve to immutable commits |
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

### 2026-08-25 release-candidate freeze

- The Landing hierarchy/refinement implementation started at `b3dded54`; the release deployment
  commit is `c568992f`. Exact-SHA Quality run `32809573250` passed the introduced-commit secret
  scan plus every wire/server/Web/CLI type, test, build, and runtime-smoke gate. The secret scan
  now uses the private Linux runner only for trusted `main`/manual events while every PR still
  selects `ubuntu-latest`; `check-public-pr-isolation.mjs` pins that event-to-runner boundary.
  This removed private-repository hosted-billing as a trusted-release dependency without letting
  fork code reach a private runner. A subsequent independent claim/security review had found
  P0=0/P1=0 and one P2: OpenCode was shown as a Web-dispatch route even though it is currently a
  CLI ACP beta. The final source instead shows the actually Web-supported Gemini beta and labels
  OpenCode's CLI boundary.
- Web-only deploy run `32809763854` succeeded at exact SHA `c568992f`. Production health returned
  OK and `/assets/index-CV7uT6xW-202608250439.js` returned JavaScript with immutable caching.
  Browser GET deep links for `/welcome` and `/docs` returned the new asset. Fresh isolated
  Chromium acceptance at 1,440×1,000 and 390×844 found zero horizontal overflow and no visible
  input below 16 px. It exercised Remote server → Gemini selection, docs → Quick start, the
  proactive mobile PWA install panel, signup mismatch validation, and terminal → structured
  Claude mirror → terminal round-trip; browser console errors were zero. Normal viewport captures
  confirmed the Hero, architecture map, real workspace proof, and continuity arrow remain clear
  without masked text at both sizes.
- The scheduler-topology Hero shipped from source `a01d1c76`. Its reducer regression tests pin
  machine/agent selection, informational side-lane inspection, route labels, and exactly two
  active-wire identities; rendered contracts pin the fixed trust chain, initial pressed state,
  token-only CSS, mobile media rule, and reduced-motion fallback. The complete Web run passed
  109 files / 1,477 tests, Vite production build, and TypeScript with zero errors. One initial
  concurrent run timed out the unrelated translation fallback test at its five-second limit;
  the isolated test then passed in 0.8 seconds and the complete rerun passed in 14.47 seconds.
  Exact-SHA Quality run `32770846354` passed and Web-only deploy `32771117550` succeeded. Production
  health returned OK; entry asset `/assets/index-u0enk5tp-202608241957.js` and public chunk
  `/assets/PwaInstallPrompt-W4_pPTXU-202608241957.js` returned JavaScript, with the latter containing
  the scheduler and boundary copy. Real production browser acceptance at 1280 px and 390 px found
  zero scheduler overflow or node overlap; the mobile graphic computed to 500 px high, all node
  targets were at least 48 px, and selecting Remote server + OpenCode then inspecting Meta Agent
  kept exactly two pressed controls/two active wires while announcing the Claude-only boundary.
  Independent re-review closed the initial topology and mobile-test findings at P0/P1/P2 = 0.
- The multi-machine command-panel follow-up passed all 108 Web test files / 1,474 tests,
  Vite production build, TypeScript with zero errors, SVG validation, diff checks, and a
  current-diff gitleaks scan. Rendered-component tests pin the initial accessible fleet state;
  formatter and breakpoint-contract tests pin the production/sidebar data shape and opposite
  desktop/mobile navigation states. Exact-SHA Quality run `32767214395` passed the complete
  wire/server/Web/CLI gate at `bb04a436`.
- Browser-to-machine file handoff was exercised against the production relay and daemon with
  two real PNG payloads: 145,259 bytes (SHA-256
  `1904987f9699504446c5454913fc986a11e9c9583f280727b54872ce9322a6ae`) and 506,218 bytes
  (SHA-256 `1ae348177b0e5af9fd5f6b03c19ae3512b14e625baf06fa599ab236018023b35`).
  Both target files matched byte-for-byte; the running Claude TUI received only the
  default-shell-quoted path and no Enter/command execution. The two test-owned files were
  moved to the target machine's Trash after verification and remain recoverable there.
- `very-happy-cli@0.2.64` was published from `v0.2.64` by run `32749236836`.
  CLI smoke run `32749236740` passed Linux and real macOS on Node 20/24; an independent install
  and HOME smoke passed. The production daemon now reports 0.2.64, the production relay/Web
  endpoints, its existing Claude credential category, and a current heartbeat.
- A production outage occurred during this freeze when an unsafe second diagnostic PGlite
  process opened the live volume concurrently and left `pg_control` pointing at an invalid
  checkpoint. The service was stopped, a complete untouched raw snapshot was retained, and
  recovery was performed only on a copy using the matching PostgreSQL 17.6 tools. Before the
  copy was swapped in, all 6 accounts, 3 machines, 322 sessions, 41,472 messages, 265 indexes,
  168 constraints, 44 migrations, message counters, sequence uniqueness, and the counter
  trigger were validated. The control/checkpoint corruption was confirmed; the recovered copy
  showed no logical table, index, constraint, sequence, or counter inconsistency in those
  checks. The original corrupt directory and raw incident snapshot remain private on the
  production host pending Owner acceptance.
- The incident mechanism is now prevented at source SHA `2300f4ab`: every repository-owned
  PGlite opener holds a kernel advisory lock on the canonical database directory inode for the
  entire database lifetime. Linux and macOS helpers use the same kernel protocol; missing
  helpers, contention, startup failure, and close failure fail closed. Symlink aliases,
  simultaneous ten-process contention, normal release, full PGlite reopen, and SIGKILL recovery
  are covered. Full Server gates passed 57 files / 408 tests with no skips, TypeScript, runtime
  build, and exact-SHA Quality run `32757748151`.
- Server deploy `32757977910` and Web deploy `32758196637` succeeded at `2300f4ab`. Production
  health returned OK, a cooperative `flock --nonblock /data/pglite` contender exited 1 while the
  server ran, and logs contained no P2028, message-500, invalid-resource-manager, or checkpoint
  errors. The required daemon refresh completed after each Server restart.
- The final narrow-terminal follow-up shipped Web source `c9a8fbb6` after Quality run
  `32758820250` and Web deploy `32759043002`. The deployed entry asset
  `/assets/index-BVsmPPwd-202608241751.js` serves as immutable JavaScript. In a real authenticated
  narrow Chrome window, `.xterm-helper-textarea` computed to 16 px with
  `visualViewport.scale === 1` and no horizontal overflow. The `/welcome#proofs` file-handoff
  control completed its interactive sanitized preview at the same narrow viewport without
  overflow. The required post-restart daemon refresh left production on 0.2.64 (PID 93827).

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

- The final density pass reduced the Landing from 13 top-level sections to seven without
  removing the real product proof: the sanitized production workspace now follows the Hero,
  while Web/PWA positioning, file handoff, agent support, first connection, and the trust
  boundary are consolidated into those primary surfaces. Local responsive measurements fell
  from 11,697/11,486/13,574/17,018 px to 6,718/7,179/8,210/9,320 px at
  1440/1024/768/390 respectively, with `scrollWidth === innerWidth` at every size.
- The same pass programmatically inspected every visible architecture label at
  390/768/1024/1440: no text clipping and no status/zone-label overlap remained. Normal browser
  clicks completed machine + agent route selection and terminal → structured conversation →
  terminal. Interactive phone geometry is stable while non-geometric light, ring, packet, scan,
  orbit, and title animations remain. An independent read-only visual review ended at P0=0,
  P1=0; both reported P2s (unlabelled narrow capability lanes and missing narrow handoff arrows)
  were fixed and rechecked.
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
- after the README/bootstrap release, production `/docs/quickstart` was hard-reloaded after
  unregistering its Service Worker at 1440x900 and 390x844. The atomic ten-line bootstrap was
  fully visible with `pre.clientWidth === pre.scrollWidth === 356` on mobile and page
  `scrollWidth === innerWidth`; the console was clean. `/install.sh` returned
  `200 application/x-sh`, `Cache-Control: no-store`, SHA-256
  `35befa57120c83587bf1ff03235ab5eee9fadb4624aea62edfe0b9f2ddfc265d`, and was byte-identical
  to the reviewed repository source. Its offline dry-run left an isolated HOME empty.
- after the Web-first release, fresh production checks at 390x844 and 1440x1000 confirmed the
  Web/PWA-first thesis, agent-independent text-TUI boundary, sanitized production UI surfaces,
  and MCP handoff positioning with zero horizontal overflow. The real Files control was
  exercised inside the shared product preview; `/docs/integrations` exposed Claude progress,
  Codex/Gemini/ACP scope, meta-agent privilege, and `--scope user` boundaries without overflow.
  The mobile pass reported no console errors or warnings.
- after the multi-machine command-panel release, the deployed asset
  `/assets/index-Dujhkol--202608241919.js` was confirmed in a service-worker-updated production
  tab. At 1440x1000 the authentic sidebar and detail remained visible together, with static
  sidebar positioning, production-shaped machine/agent/path rows, correct accessible naming,
  and no overflow. At 821 px the Hero stayed on three intentional title lines. At 390x844 the
  session list used the contained overlay, hid the underlying detail, and then opened the real
  terminal preview with focus returned inside it; all visible inputs were 16 px and neither
  state overflowed. The authenticated production root rendered 12 existing sidebar rows, all
  with machine context, without exposing their contents during verification.

### Independent review

Three independent read-only review tracks were completed after implementation:

1. Security/public-repository review: P0=0, code P1=0; remaining blockers are the
   Owner-controlled history/credential and public-switch governance actions below.
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

The GitHub README/bootstrap follow-up received separate first-user/visual/docs and
public-security reviews. They found and closed a dead CLI-doc link, post-bootstrap credential
restart gap, inaccurate dry-run/skip completion state, streaming `curl | sh`, registry access
during dry-run, unsafe endpoint/architecture assumptions, narrow-screen command overflow, and
doctor argv/environment leakage through stdout and optional remote debug logs. Both freeze
rereviews ended at **P0=0, P1=0, P2=0**; the animated SVG was also checked for external
resources, scripts, internal hosts, PII, reduced-motion behavior, and narrow GitHub rendering.

The file-handoff release received independent security/code and first-user/UX reviews after
real production transfer. Findings in account-wide RPC abuse control, upload compatibility,
mobile completed-state containment, proof wording, and interaction semantics were fixed and
rereviewed; both tracks ended at **P0=0, P1=0, P2=0**. The final PGlite incident guard then
received three adversarial security passes. They closed Docker PID-namespace, stale-lock TOCTOU,
symlink/mountpoint alias, mixed-fallback split-brain, startup/close lifetime, and concurrency-test
gaps; the third freeze ended at **P0=0, P1=0, P2=0**. A separate final mobile review confirmed
that the xterm helper 16 px floor wins the production cascade without changing visible terminal
geometry or IME composition behavior, also ending at **P0=0, P1=0, P2=0**.

The Web-first positioning follow-up received three independent freeze reviews. The code/test
review fixed missing Gemini/ACP bridge coverage and a vacuous negative test. The public-security
review narrowed Claude progress claims, documented all meta-agent additions and user-scoped MCP
blast radius, and bounded terminal compatibility to ordinary text TUIs. The first-user/UI review
removed misleading “real/live product UI” labels from sanitized fixtures. All three rereviews
ended at **P0=0, P1=0, P2=0**.

The multi-machine command-panel follow-up received a separate independent product-truth,
responsive, accessibility, and test review. It found that the first fixture combined metadata
the production sidebar did not yet render, plus a desktop overlay/ARIA mismatch. The production
sidebar gained the real machine/agent/path context, the sanitized fixture adopted that contract,
desktop/mobile computed styles were corrected and pinned, rendered accessibility tests were
added, and the final freeze rereview ended at **P0=0, P1=0, P2=0**.

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
- The GitHub second-landing-page, production Quick start bootstrap, and doctor privacy hardening
  shipped from `77fcd8ed767a0ae9d263f6964cf57e0526d7774d`. Exact-SHA Quality Gates
  `32737299751` and Web deploy `32737580364` passed, producing
  `/assets/index-BY7FNJV3-202608241415.js`. Production health/MIME, source-byte equality,
  isolated offline dry-run, and service-worker-cleared 1440x900/390x844 Docs acceptance passed.
  `very-happy-cli@0.2.62` was published by run `32737836210`; tag smoke `32737835940`
  passed on Linux and mac-office Node 20/24, and an independent registry install verified both
  runtime version and doctor argv hiding. `vh-update` moved the mac-office daemon from 0.2.61
  to **0.2.62** (PID 56230) with the production relay, Web UI, and Claude credential source
  intact. Web rollback is `6706fc8e` via `/opt/happy/webapp.prev`; CLI rollback is `0.2.61`.
- Terminal file handoff, account-scoped RPC burst protection, the public proof, and CLI 0.2.64
  shipped from `f7b0dc54e06ba07151ff2dc019773646d32e5bf3`. Publish run `32749236836`
  and tag smoke `32749236740` passed. The production file hashes and no-auto-execute evidence
  are recorded in the final freeze above.
- The PGlite lifetime lock and clean-shutdown guard shipped Server-only from
  `2300f4ab335c105a92d281806c955b7e44d8854a` by deploy `32757977910` after Quality
  `32757748151`. Web at the same source followed in deploy `32758196637`; both restarts were
  followed by the mandatory daemon refresh. Health, cooperative lock contention, existing
  account/machine/session visibility, JavaScript MIME, and error-log checks passed.
- The final iOS xterm focus-zoom fix shipped Web-only from
  `c9a8fbb69fb4a59fe8cb024ba2722fff00c4375a` by deploy `32759043002` after exact-SHA
  Quality `32758820250`. Production browser acceptance measured 16 px on the real focused
  xterm textarea at narrow width, scale 1, zero terminal/Landing overflow, and a completed
  interactive file-handoff proof. The running daemon is **0.2.64** (PID 93827); Web rollback is
  the preceding `2300f4ab` atomic deployment and CLI rollback is `0.2.63`.
- The Web-first workspace positioning, universal text-TUI explanation, and exact MCP capability
  matrix shipped Web-only from `ef74cc6700f98c74f3bd999453add80c61b7bce4` by deploy
  `32763241942` after exact-SHA Quality Gates `32762994029`. The deployed entry asset is
  `/assets/index-yZVySC_9-202608241835.js`; health, JavaScript MIME/cache, signup capacity,
  390x844 and 1440x1000 Landing/Docs acceptance, and the required daemon refresh passed. The
  running daemon is **0.2.64** (PID 26483); Web rollback is the preceding `c9a8fbb6` atomic
  deployment in `/opt/happy/webapp.prev`.
- The one-panel/many-machines positioning and production sidebar context shipped Web-only from
  `bb04a436848d6533f4e636ac13fbf123ccfb952b` by deploy `32767449867` after exact-SHA
  Quality Gates `32767214395`. The deployed entry asset is
  `/assets/index-Dujhkol--202608241919.js`; health, JavaScript MIME/cache, signup capacity,
  authenticated-root compatibility, and 1440/821/390 browser acceptance passed. Server and CLI
  were unchanged, so no daemon restart was required; the existing daemon remains healthy on
  **0.2.64** (PID 26483). The atomic Web rollback is the preceding `ef74cc67` deployment.
- Production auth capacity at verification time: open signup, maximum 100 accounts,
  6 registered, 94 remaining.

## Blocking historical findings

A final current-tree archive plus the readiness report processed 16.88 MB and returned **0
findings**; every staged release increment was also scanned with no finding. A fresh all-ref scan
of the current private object database covered 2,609 commits / about 35.63 MB and returned **45
findings** across 14 commits and 13 paths: 7 GCP API key, 30 generic API key, and 8 JWT
detections. This is the release-freeze baseline; changing visibility before rewriting it would
publish known session/token material.

Those 45 detections collapse to 20 unique values. The deleted real-session JSONL accounts for
22 detections and contains user content plus local/token material. Four distinct EdDSA JWTs are
parseable and have `iat`, `iss`, `jti`, `nbf`, and `sub` claims but no `exp`; they therefore
cannot be assumed expired. Other historical objects include a Gemini OAuth client secret, one
repeated GCP mobile key, local keys, deterministic KDF/env test values, component-version strings,
and documentation false positives. No raw secret or stable secret fingerprint was copied into
this report. The conservative rewrite still removes every manifest path, and the JWT/session,
OAuth, GCP, and local-key owners must explicitly confirm invalidation or restriction.

A disposable-mirror rewrite rehearsal then removed the finding paths, their historical rename
destinations, the known environment/deployment files, and historical session fixtures from all
commit refs. The first pass reduced 45 findings to 21, the rename-complete second pass to 6, and
the final pass to zero. The 14 clean files that still exist on current `main` were restored from
the current tree in one synthetic rehearsal commit. The result scanned **2,605 commits / 32.02
MB with zero findings**, and `git ls-tree -r main` was byte-for-byte identical to current `main`.
This proves the path manifest is sufficient for a clean staging history without changing product
contents. The rehearsal did not alter or push the shared repository. Local Codex checkpoint refs
whose targets are trees rather than commits must not be copied to the staging remote.

The most serious object is a deleted upstream real-session JSONL containing tokens and user
content. Historical Google/Firebase configuration and old environment/deployment files also
need explicit disposition. At minimum, build the rewrite manifest from the scanner report and
these known paths:

```text
android/app/google-services.json
cli/explore-claude-cli/v1-real-sessions-by-kirill-from-handy-cli/example-sessions/400429ba-c1e1-4ef5-a7ec-fe40608df53b.jsonl
cli/notes/message-type-drift.md
cli/src/commands/connect/authenticateGemini.ts
cli/src/utils/deriveKey.appspec.ts
cli/src/utils/expandEnvVars.test.ts
docs/configuration.md
docs/plans/happy-agent.md
expo-app/android/app/google-services.json
expo-app/google-services.json
expo-app/ios/Podfile.lock
expo-app/sources/encryption/deriveKey.appspec.ts
google-services.json
ios/Podfile.lock
packages/happy-app/android/app/google-services.json
packages/happy-app/google-services.json
packages/happy-app/ios/Podfile.lock
packages/happy-app/sources/encryption/deriveKey.appspec.ts
packages/happy-cli/src/commands/connect/authenticateGemini.ts
packages/happy-cli/src/utils/deriveKey.appspec.ts
packages/happy-cli/src/utils/expandEnvVars.test.ts
sources/encryption/deriveKey.appspec.ts
sources/sync/__testdata__/log_0.json
packages/happy-server/.env.dev
packages/happy-cli/.env.dev
packages/happy-cli/.env.dev-local-server
packages/happy-cli/.env.integration-test
packages/happy-server/deploy/overlays/local/secrets.yaml
packages/happy-cli/src/claude/utils/__fixtures__/
```

Some scanner hits are test vectors or public mobile configuration, but they must be reviewed
and allowlisted only after the real session/token objects are removed. Treat every historical
credential as exposed until its owner confirms restriction, revocation, or rotation.

## Owner-only public switch procedure

These operations are intentionally not performed by this release-candidate work:

1. Freeze pushes and tags. Create an offline mirror/bundle backup and record current ref→SHA
   mappings. Keep that backup private.
2. In a disposable isolated mirror, apply the reviewed, rename-complete path manifest proven by
   the rehearsal above. Remove session dumps, environment/secrets files, and sensitive blobs from
   **all commit refs**, including tags. Restore only the 14 current clean files from frozen `main`
   and verify the resulting `main` tree is identical before publishing it.
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

## Current public-switch blocker

- The code/deploy gate is no longer blocked: trusted `main` runs have a green exact-SHA secret
  scan and package gate, while the PR runner-selection contract remains hosted-only. The current
  GitHub repository must nevertheless remain private because its unchanged object database still
  contains the 45 findings documented above. Public visibility is allowed only after the proven
  rewrite is applied to a staging history, historical credentials/sessions are invalidated, and
  fork-PR isolation plus repository protections are verified on the publish target.
- GitHub currently returns 403 for branch-protection and ruleset administration on this private
  repository's plan. The protections can be configured after the sanitized staging repository is
  public (or after an Owner plan upgrade), so this platform constraint is part of the public-switch
  ceremony rather than a reason to expose the unsanitized source repository first.

## Known non-blocking limitations

- End-to-end encryption is deliberately deferred. The August 25 protocol and client/server
  experiment is preserved on `codex/e2ee-experimental-archive-2026-08-25` at `408742b7`; it was
  never enabled or deployed. `main` reverted it in `e1c2b990` because its recovery-code and
  per-device activation model made ordinary cross-device password/Google login materially more
  complex. The release remains explicitly server-trusted. A future E2EE design must preserve the
  default “sign in on a new device and continue” journey, make recovery and revocation legible,
  and complete every data/control plane before any public E2EE claim.
- The history-only `packages/happy-app` Tauri archive is excluded from the pnpm workspace, CI,
  production, and the supported product. Its transitive `bytes` advisory is patched at 1.11.1 and
  `cargo check --locked` passes. Its Tauri 2/Wry GTK3 stack still resolves `glib` 0.18, which has a
  medium advisory and no compatible 0.20 upgrade in that stack; the Dependabot alert is dismissed
  as tolerable only while the archive remains non-shipping. Reopen and resolve it with the
  Tauri 3/GTK4 migration, or before restoring this archive as a supported build target.
- The server image still runs as root and is 1.55 GB. Reducing privileges and image size is a
  worthwhile defense-in-depth follow-up, not an unaddressed release P1.
- The PostgreSQL smoke service uses a major-version tag; the shipping Node base is digest-pinned.
- PGlite migration SQL and its migration marker have a narrow crash window between operations.
- PGlite is supported only on a local filesystem and by one cooperative Server/migration process
  at a time. The directory-inode lock prevents a second repository-owned opener on supported
  local Linux/macOS hosts; NFS or another filesystem without reliable advisory locks is not
  supported. External diagnostic tools must operate only after shutdown and on a complete copy.
- Private raw/corrupt snapshots from the 2026-08-25 recovery remain on the production host for
  Owner acceptance and rollback. They are not in Git and should be removed under the backup
  retention policy only after acceptance; they may contain production account/session data.
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

**NOT READY only because of Owner-controlled irreversible public-switch actions:** the shared
history has not been replaced with the proven zero-finding rewrite; historical credentials and
sessions have not been invalidated; and repository protections, a real fork-PR isolation drill,
external OAuth/Cloud policy checks, and the final Owner public-release acceptance have not been
completed on the publish target. The exact-SHA code/deploy gate is green and the Landing is live.
The current source tree, product flow, documentation, self-host distribution, deployed service,
and CLI release otherwise remain an open-source release candidate with no known in-scope P0/P1/P2.
