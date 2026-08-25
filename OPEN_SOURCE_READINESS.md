# Open-source readiness

> Assessed: 2026-08-25 (Asia/Singapore)
>
> Public candidate base: `12861872` on `main`
>
> Decision: **READY**

Very Happy's product, sanitized public lineage, fork isolation, canonical clone,
production health checks, and protected readiness merge are complete. There are
no confirmed P0/P1 findings or remaining irreversible Owner actions in scope.

## Product delivered

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
- Public copy consistently states that the relay is trusted and the product is
  **not end-to-end encrypted**. The canceled E2EE experiment is not published.
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
| Quality Gates | Run `32816809293`: success on the exact public base |
| CLI Smoke | Run `32816809328`: Linux/macOS, Node 20/24, success |
| Protected PR | PR #1 run `32817704371`: all three required checks passed without bypass |
| Fork isolation | PR #2 from `MiroMindAI` run `32817718015`: all checks passed on `ubuntu-latest`; 0 public runners/secrets/variables; closed unmerged |
| Web | 109 test files / 1,477 tests; Vite production build; TypeScript zero errors |
| CLI | 129 test files / 1,241 tests; build, types and isolated HOME runtime; final real-tmux follow-up 20/20 targeted tests |
| Server | 57 test files / 408 tests; TypeScript zero errors; container/migration/persistence checks |
| Wire / agent | Wire 2 files / 19 tests; agent 9 files / 229 tests; clean builds |
| Clean install | Frozen-lockfile output-free checkout; server tarball migration; CLI tarball postinstall/version smoke in isolated prefix/HOME |
| New user | Signup, pairing, daemon, machine discovery, tmux terminal/file preview, and no-tmux downgrade exercised on an isolated machine |
| Browser | Fresh desktop/phone Chromium: landing/docs, signup errors, PWA prompt, scheduler, terminal/structured handoff, no overflow, 16 px inputs, zero console errors |
| Production | Web deploy `32812476449` from `a49adce7`; post-publication health OK; GET `/welcome` and `/docs`, manifest, service worker and immutable asset verified |
| Canonical clone | Fresh `https://github.com/Mereithhh/very-happy` clone: 2,617 commits scanned, gitleaks 0, fsck strict pass, no legacy tags/private emails |
| Reviews | Independent security/public-repo, code/release, and first-user/UI/docs reviews; confirmed P0/P1 closed |

The terminal auto-restore follow-up covers cwd/title/terminal identity, resume
command injection, stale/missing/bare-shell refusal, shutdown safety, and
idempotence with real tmux. Restored-mark retention is separately pinned as a
pure regression so a transient empty probe cannot consume the badge.

## Deployment and version lineage

- Production Web source is `a49adce7`, deploy run `32812476449`, entry asset
  `index-IwacsF_b-202608250521.js`.
- Production CLI is `very-happy-cli@0.2.64`. Public source retains historical
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

## Publication closeout

- [x] The verified readiness branch was merged into protected `main` without bypass (`52669cc2`).
- [x] A fork-origin pull request proves hosted-runner/no-secret isolation.
- [x] The original repository is renamed as a private archive/release plane.
- [x] The sanitized repository has the canonical `Mereithhh/very-happy` name.
- [x] A fresh canonical clone passes ref, fsck, gitleaks, identity and runner checks.
- [x] Production health and public landing/docs/PWA endpoints remain healthy.

No history force-push, production data deletion, DNS change, external ownership
change, or credential rotation is part of this publication procedure.

**Conclusion: READY.**
