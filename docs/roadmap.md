# Very Happy roadmap

## North star

**Work anywhere, while carrying as little operational context in your head as
possible.** Very Happy should remember the sessions, files, tasks, decisions,
interruptions, and agent handoffs around a piece of work. Desktop, mobile, and
voice are different entrances to the same workspace—not separate products.

This is not a promise to hide the machine. The common path should be calm and
structured, while a real terminal stays one step away whenever complete control
is required.

This roadmap uses three explicit horizons. “Available now” describes code in the
current release. “Next” is intended direction, not a compatibility promise or
release date. “Long-term concept” is product exploration.

## Available now

### Work surfaces

- Structured Claude Code sessions with tools, diffs, permission requests,
  attachments, usage, and resume. An optional, explicitly installed hook pair
  mirrors hand-started Claude inside Very Happy terminals into that view.
- Durable remote terminals with reconnect, local scrollback, mobile input, file
  browsing, rich previews, notes, notifications, and a task board.
- Responsive Web/PWA access across desktop, phone, tablet, and foldable layouts.

### Agents and coordination

- Claude Code as the deepest provider integration, plus Codex sessions.
- A beta Agent Client Protocol backend with Gemini and OpenCode presets plus a
  generic runner for commands that expose compatible ACP over stdio. Provider
  parity is not implied.
- An OpenClaw adapter that connects through a configured local gateway using
  OpenClaw's own protocol, not ACP.
- A Claude-powered text meta-agent with session awareness and dispatch on its
  selected machine. Voice entry is available when a compatible voice service is
  configured; both meta-agent modes currently require Claude Code.
- Provider-style inbound commands and outgoing HTTPS webhooks for connecting
  external task and notification systems.

### Operation

- A capacity-limited community Cloud or a self-hosted trusted relay.
- Password and Google identities, configurable signup policy and account cap,
  machine pairing, and explicit resource limits.
- A server-trusted security model. Self-hosting changes the operator; it does not
  turn the protocol into end-to-end encryption.

## Next

### A provider-aware coordination layer

- Make the meta-agent a dependable dispatcher across supported agents,
  providers, machines, and future checkouts.
- Preserve subtask progress and return decisions, blockers, and results instead
  of making the user watch activity.
- Add adapters only where they improve real workflows. Pi is a candidate, not a
  supported integration until it is implemented and tested.
- Deepen task-provider and development-provider integrations without making any
  one vendor the center of the product.

### Durable work memory

- Promote workspace, project, checkout, and task memory to first-class concepts.
- Make interruption recovery include the goal, active decisions, related files,
  agent ownership, and next action—not only a resumed terminal process.
- Add explicit session forking and multi-agent review flows with legible
  ownership, progress, cost, and cancellation.

### Less attention management

- Route notifications using presence and activity instead of broadcasting every
  event to every device.
- Add scheduled work and repeatable pipelines with clear approval boundaries.
- Keep improving keyboard, touch, foldable, accessibility, and low-bandwidth
  behavior so mobile access remains a first-class work surface.
- Keep the installable Web/PWA as the default client while evaluating the
  retained Tauri shell as an optional desktop client with tighter operating
  system integration. It is not a committed or supported release yet.

## Long-term concept: the virtual office

A multi-agent virtual office is one possible interface for the north star: a
legible, perhaps pixel-art space where work has presence, agents have roles, and
the user can see where judgment is needed and enter the right conversation.

The visual metaphor is optional. The requirement is measurable: less context
reconstruction, fewer unnecessary interruptions, clearer handoffs, and the
ability to move between devices without losing the work.

## How roadmap items become commitments

Ideas are not treated as shipped because they appear here. A roadmap item becomes
a release commitment only after its behavior, trust boundary, compatibility, and
failure modes are specified under `specs/`, implemented with proportional tests,
and recorded as shipped in the release notes.
