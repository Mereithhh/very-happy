# UI agent inputs and reasoning controls

Status: Final
Backlog: B-428

## Verified current behavior

- Codex uses stdio app-server (`packages/happy-cli/src/codex/codexAppServerClient.ts`).
- Web blocks non-Claude attachments in AgentInput.tsx and sync.ts despite session attachmentKinds metadata.
- Claude safely stages arbitrary attachments via claude/utils/attachmentContent.ts.
- modelModeOptions.ts hardcodes per-agent effort; pi ACP modes represent thinking, not permissions.

## Contract

Advertise attachment support only after the runner can consume it. Reuse encrypted file transport and private staging; images enter native image content, other files enter a machine-local manifest. Attachment-only messages must survive queues. Fail visibly, never silently discard files.

Model and effort discovery are authoritative per session/model; preserve exact backend identifiers. GPT-6 Astra fallback is based on official documentation, not guessed aliases. Unsupported stored effort must not be sent as an apparently valid selection. pi thinking remains independent of file-backed permission mode. Codex yolo retains its native approval/sandbox mapping; pi exposes only actually implemented ask/bypass modes.

All conversation effort controls use a discrete accessible slider, with explicit default where supported. Highest supported level triggers a brief monochrome burst/sweep, respecting reduced motion. Both themes, coarse-pointer mobile, keyboard and overflow are browser-verified.

## Compatibility and delivery

New optional metadata fields must remain optional and tolerate unknown future strings. New Web + old runner hides unsupported attachments and uses conservative effort fallback. Old Web + new runner retains existing behavior. Build wire before dependents. Deploy server/Web before CLI; new capabilities become available on newly started/upgraded wrappers. No production deployment is implied by this implementation task.

## Validation

Regression tests cover native image payload, arbitrary files, attachment-only queueing, capability gates, effort/model mapping and permission independence. Browser evidence covers desktop/mobile and light/dark controls, end-stop animation and reduced motion. Run repository gates before merge.

## Runtime evidence (2026-09-09)

Upgraded the active fnm npm Codex CLI 0.147.0 → 0.153.4. model/list then exposes gpt-6-astra as default, effort low/medium/high/xhigh/max/ultra (default low). This Codex catalog differs from API documentation; preserve the host catalog. Native localImage + read-only file-tool smoke correctly returned the fixture code and both image colours.

Codex 0.153.4 rejects on-failure at thread/start. safe-yolo now uses on-request + workspace-write (also supported by older clients), preserving sandbox escalation approvals. Ordinary yolo remains never + danger-full-access.

## Model choices persist as defaults

Owner clarified that selecting a model in any pi conversation must become the next pi session's default, without revisiting Settings. AgentInput already updates agentDefaultOverrides, but spawn RPC only transmits permissionMode; pi startup therefore reports the machine's GLM default until a prompt applies the saved model. Add optional `model` to spawn RPC, forward the exact saved provider/model identifier for fresh pi sessions, and initialize the ACP selector before reporting readiness. Forks/assistant variants retain their own intent. Older daemons ignore the field; subsequent messages still carry saved intent. Do not hardcode a private provider identifier as the public product default.

## Validation evidence

Real Chromium component/dialog tests passed at desktop and 390px coarse pointer in light/dark themes, including keyboard, controlled-value updates, explicit unknown stop, repeated maximum animation and reduced motion. Animation pixel differences were measured, not inferred from classes. Source assertion mutation check caught removal of the mobile slider.

Native Codex fixture smoke returned the file verification code and correct red/blue halves. pi ACP image blocks retain exact bytes in regression tests; its probed default GLM model successfully read a file but explicitly lacks vision. Image interpretation therefore requires a vision-capable model, noted in the composer.
