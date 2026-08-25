# Open-source readiness

> Assessed: 2026-08-25 (Asia/Singapore)
>
> Protected public `main` after the readiness merge: `1bbd6bef`
>
> Decision: **READY for Owner final confirmation**

Very Happy's product, sanitized public lineage, fork isolation, canonical clone,
production health checks, and protected readiness merge are complete. There are
no confirmed P0/P1 findings. Owner acceptance is limited to external Google
OAuth/Cloud policy, the Android Chrome tactile check, and release messaging.

## Product delivered

- Passwordless Email OTP is implemented with Cloudflare Email Sending and
  Resend adapters, durable HMAC-hashed single-use challenges, bounded attempts,
  long-window abuse budgets, and a startup guard that prevents password-only
  account lockout. Email becomes the default Web method only when configured;
  otherwise existing password and Google login remain compatible.
- Private exact-SHA Quality run `32830436767`, production Server deploy
  `32830672345`, Web deploy `32830827506`, and mac-office daemon reconnect all
  passed. Public PR [#6](https://github.com/Mereithhh/very-happy/pull/6) passed
  hosted secret scan, container migration/persistence smoke, every package gate,
  and GitGuardian before merging. Production delivery is deliberately dormant
  until the operator configures a verified sender and scoped provider token.

- Responsive `/welcome` landing and `/docs` surfaces cover quick start, CLI and
  daemon setup, Cloud/self-hosting, configuration, architecture, security and
  privacy, accounts and quotas, operations, troubleshooting, and contributing.
- The Web/PWA-first story uses authentic production-style interactions: a fleet
  panel, tmux terminal, structured Claude conversation, files and previews,
  task board, command palette, mobile handoff, and optional meta-agent surfaces.
- Onboarding includes Node, tmux and provider prerequisites, `very-happy auth`,
  Web approval, diagnostics, and the required `very-happy daemon start` step.
- Claude structured sessions, the agent-independent native TTY/TUI path, Codex,
  and the ACP beta boundary are described according to the implementation. Pi,
  automatic routing, and the pixel office remain roadmap.
- Security, Privacy, and Terms document the trusted-relay boundary; marketing
  does not use it as a warning banner and no surface claims end-to-end encryption.
- Password and Google signup, global capacity, pairing, rate/resource limits,
  actionable failures, PWA installation, and first-machine recovery are covered.
- The experimental Tauri shell is retained for future desktop work; Web/PWA is
  the recommended and supported client experience.

## Security and repository posture

- Full public lineage gitleaks: 0. Fresh-clone `git fsck --full --strict`: pass.
  Private/local author email scan: 0.
- Historical private paths, session material, credentials, infrastructure facts,
  and PII were removed before publication. Only sanitized `main` was pushed;
  legacy tags, hidden PR refs, private feature branches, and E2EE were excluded.
- Pull-request jobs run only on GitHub-hosted runners with `contents: read`.
  Deploy and npm publish do not accept PR triggers. The public repository has
  zero self-hosted runners, Actions secrets/variables, and hooks.
- Actions are pinned to immutable SHAs. Repository SHA pinning, secret scanning,
  push protection, vulnerability alerts, Dependabot security updates, external
  workflow approval, and read-only workflow permissions are enabled.
- Protected `main` rejects deletion and force-push and requires pull requests,
  current branches, resolved threads, and all three Quality Gates checks.
- Authentication/OAuth, signup capacity, pairing, socket ownership, terminal
  boundaries, rate/resource limits, webhook SSRF, logging, attachment limits,
  and database single-writer behavior have regression coverage.
- `SECURITY.md`, license, upstream attribution, contribution guidance, code of
  conduct, issue templates, and CODEOWNERS are present.

## Verification evidence

| Area | Evidence |
|---|---|
| Public base | `12861872ee701526f4644f763a83b431fe252d4b`; explicit-main-only push |
| Quality Gates | PR #4 run `32825832908`: quality, server container/migration/persistence and introduced-commit secret scan passed |
| CLI Smoke | PR #4 run `32825833131`: Linux Node 20/24 passed; private macOS/Windows jobs are intentionally unavailable to public PRs |
| Post-merge main | Exact head `1bbd6bef`: Quality `32826119316` and CLI Smoke `32826119257` passed |
| Protected PR | PR #1 run `32817704371`: all three required checks passed without bypass |
| Fork isolation | PR #2 from `MiroMindAI` run `32817718015`: all checks passed on `ubuntu-latest`; 0 public runners/secrets/variables; closed unmerged |
| Web | 112 test files / 1,495 tests; Vite production build; TypeScript zero errors |
| CLI | 129 test files / 1,242 tests; build, types, isolated HOME runtime, public Linux smoke and private real-macOS Node 20/24 tag smoke |
| Server | 58 test files / 410 tests; TypeScript zero errors; container/migration/persistence checks |
| Wire / agent | Wire 2 files / 19 tests; agent 9 files / 229 tests; clean builds |
| Clean install | Frozen-lockfile output-free checkout; server tarball migration; CLI tarball postinstall/version smoke in isolated prefix/HOME |
| New user | Signup, pairing, daemon, machine discovery, tmux terminal/file preview, and no-tmux downgrade exercised on an isolated machine |
| Browser | Fresh desktop/phone Chromium: landing/docs, signup errors, PWA prompt, scheduler, terminal/structured handoff, no overflow, 16 px inputs, zero console errors |
| Production | Web deploy `32822501595` from `caa53f11`; Server deploy `32823571969` with code `7bf65e16`; CLI 0.2.67; health, single runtime config, manifest, service worker and immutable asset verified |
| Canonical clone | Fresh `https://github.com/Mereithhh/very-happy` clone: 2,617 commits scanned, gitleaks 0, fsck strict pass, no legacy tags/private emails |
| Reviews | Independent security/public-repo, code/release, and first-user/UI/docs reviews; confirmed P0/P1 closed |

The terminal auto-restore follow-up covers cwd/title/terminal identity, resume
command injection, stale/missing/bare-shell refusal, shutdown safety, and
idempotence with real tmux. Restored-mark retention is separately pinned as a
pure regression so a transient empty probe cannot consume the badge.

## Deployment and version lineage

- Production Web source is `a49adce7`, deploy run `32812476449`, entry asset
  `index-IwacsF_b-202608250521.js`. The final mobile terminal release supersedes it:
  source `caa53f11`, deploy `32822501595`, entry `index-BODNfbYU-202608250737.js`.
- Production Server code is `7bf65e16`, deployed by run `32823571969`; `/` and
  `/welcome` each contain exactly one runtime config for `https://veryhappy.dev`.
- Production CLI is `very-happy-cli@0.2.67`. Quality `32824942499`, tag publish
  `32825204241`, and Linux/real-macOS Node 20/24 smoke `32825204211` passed.
  mac-office runs 0.2.67 after real-credential preflight and restart. Doctor/status
  omit the daemon control token and report only `controlAuthentication=configured`.
  Public source retains historical
  package metadata `0.2.61`; that version must not be republished.
- The first public-lineage release should be `v0.3.0` or later, after a deliberate
  version/changelog PR and isolated packed-CLI smoke. Old private tags must not
  be recreated because rewritten history would invalidate provenance.
- Production deploys remain on the private release plane until production
  automation can move without exposing secrets or private infrastructure.

## Accepted limitations

- Cloud operators can access relayed content and metadata. Self-hosting changes
  the operator; it does not make the current protocol E2EE.
- Durable terminal continuity requires tmux. Unsupported/no-tmux environments
  use a non-durable direct shell.
- Voice/meta-agent setup is optional, partly Claude-specific, and high privilege.
- The retained desktop/Linux graph has one accepted medium `glib` advisory.
  Reopen it before claiming or releasing Linux desktop support; it does not
  affect the shipped Web, server, or CLI path.
- Public Cloud capacity and abuse controls are configurable; there is no SLA.
- Mobile terminal focus/gesture tests cover tap-versus-drag, compatibility mouse,
  normal/alternate buffers, fling cancellation and RPC batching. Desktop emulation
  cannot reproduce Android Chrome's real soft keyboard; V-081 is the final tactile
  acceptance pass and is not falsely claimed as automated evidence.

## Publication closeout

- [x] PR #4 was merged into protected `main` without bypass (`1bbd6bef`).
- [x] A fork-origin pull request proves hosted-runner/no-secret isolation.
- [x] The original repository is renamed as a private archive/release plane.
- [x] The sanitized repository has the canonical `Mereithhh/very-happy` name.
- [x] A fresh canonical clone passes ref, fsck, gitleaks, identity and runner checks.
- [x] Production health and public landing/docs/PWA endpoints remain healthy.

No history force-push, production data deletion, DNS change, external ownership
change, or credential rotation is part of this publication procedure.

**Conclusion: READY for Owner final confirmation.**
