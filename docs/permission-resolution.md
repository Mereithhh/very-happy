# Permission resolution

This document describes the production Web V2 client and current CLI. The
legacy Expo app under `packages/happy-app` is not a supported public client.

## Safety baseline

A genuinely fresh Web device starts new sessions in **Review Changes First**
mode. Claude starts in `plan`; Codex starts `read-only`; Gemini uses `plan`;
OpenClaw keeps its adapter default. The preference is device-local and visible
under **Settings → Agents → New sessions**.

Devices that already had Very Happy local settings before this safer default
retain their historical auto-apply behavior. This protects existing workflows
without silently granting the same authority to a new public user. Review the
toggle on every browser/device you use.

Direct CLI invocation with no explicit permission option uses `default`, never
`yolo`/`bypassPermissions`. Full auto-apply remains an explicit choice through
`--yolo`, `--permission-mode`, or Settings → Agents.

## Modes

The shared wire type is:

`default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo`

Agents do not implement identical policies:

- Claude SDK: `default`, `acceptEdits`, `bypassPermissions`, `plan`. Cross-agent
  values map in `happy-cli/src/claude/utils/permissionMode.ts`.
- Codex: maps the selection to its approval policy and filesystem sandbox;
  `read-only` is the strict review-first choice and `yolo` is unrestricted.
- ACP/OpenClaw: enforce only the modes supported by their adapter/provider.

Do not infer a stronger sandbox than the selected agent actually provides.

## New Web session

The production entry points—quick create, the New Session dialog, and machine
detail—resolve the initial mode in this order:

1. Use the explicit per-agent default chosen in **Settings → Agents** or in
   that agent's conversation composer.
2. Otherwise, if the device's **Review Changes First** toggle is on, use the
   agent-specific review-first mode.
3. Otherwise use the established code default (`bypassPermissions` for Claude,
   `yolo` for Codex, adapter default for the others). This third branch is for
   devices that explicitly kept historical auto-apply behavior.

The chosen value is sent in the authenticated `spawn-happy-session` RPC. The
daemon allowlists it before adding `--permission-mode` to the child process.

## During a session

The session input's model, permission, and effort selectors update both the
current session and that agent's synced default. New sessions therefore inherit
the latest explicit choice on every device. Outbound messages prefer the
per-session value, then the explicit per-agent default. The CLI validates
incoming mode values before applying them. A crafted unknown mode cannot widen
access.

## Managed sandbox exception

When the daemon's separately configured Very Happy sandbox owns isolation, the
Claude launcher may use bypass permissions *inside that sandbox* so Claude's own
approval loop does not fight the outer policy. Disabling the outer sandbox
removes that justification; it does not turn bypass into a safe mode.

## Operator/user checklist

- New users: leave **Review Changes First** enabled until the machine and relay
  trust boundary are understood.
- Existing users: inspect the toggle because legacy devices intentionally keep
  their prior behavior.
- Treat `yolo`, `bypassPermissions`, `--dangerously-skip-permissions`, and a
  daemon-managed unrestricted sandbox as remote code execution under the daemon
  OS user.
- Machine approval authenticates the machine; it does not approve every future
  command. Permission mode is the separate execution-policy control.
