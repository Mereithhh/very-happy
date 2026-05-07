# Changelog

## Version 11 - 2026-05-07

A major desktop refresh, built-in file editing, and the ability to fork or rewind any Claude session.

- Added — Codex-style sidebar with persistent header, logo, navigation buttons, and settings at the bottom. Chat header simplified with clickable title and folder name.
- Added — Zen mode: hide all sidebars for a distraction-free view. Press Escape to exit on desktop.
- Added — All Files tab in the sidebar — browse your project's file tree, search files, and open them inline.
- Added — Built-in file viewer and editor with syntax highlighting for 22 languages. Detects on-disk conflicts while you edit and shows a diff before overwriting.
- Added — All-files diff view: see every changed file's diff at a glance from the sidebar.
- Added — Unread session indicators — a blue dot appears when a session finishes while you're looking elsewhere.
- Added — Image attachments: paste or pick images to attach to Claude messages. End-to-end encrypted upload, inline rendering in chat. Enable in Settings → Experiments. (Off by default.)
- Added — Session fork and duplicate: branch an active or disconnected session into a fresh conversation with the same context, or rewind to any earlier message and try again. Long-press a user message for a shortcut. Enable in Settings → Experiments. (Off by default.)
- Added — Effort selector now actually changes how the model thinks — previously it was a UI-only knob.
- Added — Smarter push notifications: suppressed when you're actively using the desktop or mobile app.
- Fixed — Old sessions that refused to load due to a sync deadlock.
- Fixed — Blank screen on launch when machine sync hangs.
- Fixed — "Two cursors" bug when switching from remote to local mode in the terminal.
- Fixed — `claude --resume` picker now shows sessions launched from Happy.
- Fixed — Ctrl-C in the terminal keeps the session visible and resumable instead of archiving it.

## Version 10 - 2026-05-06

Branch a Claude session, rewind to any earlier message, and never lose context to a flaky session again.

- Added — Fork a session to continue with the same context in a fresh session row, on the same machine.
- Added — Duplicate from message: pick a user message as the rewind point and start a new session truncated to everything before it. Works from a bottom-sheet picker on the session-info screen, and via long-press on any user message in chat.
- Added — Forked-from link on session-info, so you can jump back to the parent session of any branch.
- Hard-fail when the chosen rewind point is no longer present on disk — no more silent untruncated copies pretending to honour the cut.

## Version 9 - 2026-04-26

Voice reliability, better content rendering, and a new diff viewer.

- Fixed voice calls breaking on second session — works reliably every time now
- Tables and code blocks scroll horizontally instead of overflowing
- New diff viewer with syntax highlighting and unified/split toggle (desktop and web only)
- Model and effort level choices now persist on mobile
- Permission prompts (accept/reject) no longer get lost
- Settings no longer randomly reset during sync
- Added scroll-to-bottom button in chat
- Delete machines you no longer use from settings

## Version 7 - 2026-04-08

This preview release expands the current update with the latest Gemini models, a smarter voice onboarding flow, and more reliable Happy CLI sessions for plan approvals and Codex turns.

- Update Happy CLI with `npm i -g happy`
- Added the latest Gemini models to the picker
- Improved voice onboarding with smarter first-run prompts and clearer upgrade guidance for free users
- Fixed Happy CLI plan approval flows so Accept and Reject buttons show up reliably in plan mode
- Fixed Happy CLI background task updates and Codex turns that could sometimes hang or fail to complete

## Version 6 - 2026-03-19

This is the biggest update since launch — a redesigned session creation experience, Git worktree management, expanded agent support.

- New session composer screen with machine selection, worktree picker, draft persistence, and offline machine visibility.
- Git worktree management — list, create, and select worktrees from the app. Worktrees auto-cleanup on session delete.
- Automatic plan mode switching when your agent enters planning mode.
- OpenClaw added as a selectable AI agent alongside Claude Code and Codex.
- Session quick actions for faster interaction with active sessions.
- Session resume support — pick up where you left off.
- Delete sessions directly from the session info screen.
- Renamed "bypass" permission mode to "yolo" with updated styling.
- Improved markdown rendering and message formatting.
- Improved message sync reliability with edge case fixes.
- Various UI polish: send spinner, hidden internal tool calls, improved spacing.

## Version 5 - 2025-12-22

This release expands AI agent support and refines the voice experience, while improving markdown rendering for a better chat experience.

- We are working on adding Gemini support using ACP and hopefully fixing codex stability issues using the same approach soon! Stay tuned.
- Removed model configurations from agents. We were not able to keep up with the models so for now we are removing the configuration from the mobile app. You can still configure it through your CLIs, happy will simply use defaults.
- Elevenlabs ... is epxensive. Voice conversations will soon require a subscription after 3 free trials - we'll soon allow connecting your own ElevenLabs agent if you want to manage your own spendings.
- Improved markdown table rendering in chat - no more ASCII pipes `|--|`, actual formatted tables (layout still needs work, but much better!)

## Version 4 - 2025-09-12

This release revolutionizes remote development with Codex integration and Daemon Mode, enabling instant AI assistance from anywhere. Start coding sessions with a single tap while maintaining complete control over your development environment.

- Introduced Codex support for advanced AI-powered code completion and generation capabilities.
- Implemented Daemon Mode as the new default, enabling instant remote session initiation without manual CLI startup.
- Added one-click session launch from mobile devices, automatically connecting to your development machine.
- Added ability to connect anthropic and gpt accounts to account

## Version 3 - 2025-08-29

This update introduces seamless GitHub integration, bringing your developer identity directly into Happy while maintaining our commitment to privacy and security.

- Added GitHub account connection through secure OAuth authentication flow
- Integrated profile synchronization displaying your GitHub avatar, name, and bio
- Implemented encrypted token storage on our backend for additional security protection
- Enhanced settings interface with personalized profile display when connected
- Added one-tap GitHub disconnect functionality with confirmation protection
- Improved account management with clear connection status indicators

## Version 2 - 2025-06-26

This update focuses on seamless device connectivity, visual refinements, and intelligent voice interactions for an enhanced user experience.

- Added QR code authentication for instant and secure device linking across platforms
- Introduced comprehensive dark theme with automatic system preference detection
- Improved voice assistant performance with faster response times and reduced latency
- Added visual indicators for modified files directly in the session list
- Implemented preferred language selection for voice assistant supporting 15+ languages

## Version 1 - 2025-05-12

Welcome to Happy - your secure, encrypted mobile companion for Claude Code. This inaugural release establishes the foundation for private, powerful AI interactions on the go.

- Implemented end-to-end encrypted session management ensuring complete privacy
- Integrated intelligent voice assistant with natural conversation capabilities
- Added experimental file manager with syntax highlighting and tree navigation
- Built seamless real-time synchronization across all your devices
- Established native support for iOS, Android, and responsive web interfaces
