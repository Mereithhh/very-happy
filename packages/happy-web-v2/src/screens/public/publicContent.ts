import { PUBLIC_DOCS_ZH_HANS } from './publicContent.zhHans';

export const GITHUB_URL = 'https://github.com/Mereithhh/very-happy';
export const INSTALL_COMMAND = 'npm install -g very-happy-cli';
export const BOOTSTRAP_COMMAND = `(\n  set -eu\n  vh_installer=$(mktemp)\n  trap 'rm -f "$vh_installer"' \\\n    EXIT HUP INT TERM\n  curl -fsSL \\\n    https://veryhappy.dev/install.sh \\\n    -o "$vh_installer"\n  sh "$vh_installer"\n)`;
export const LOGIN_COMMAND = 'very-happy auth login';
export const DAEMON_START_COMMAND = 'very-happy daemon start';
export const PROVIDER_KEY_COMMAND = `printf 'Anthropic API key: '
if [ -n "\${ZSH_VERSION:-}" ]; then
  read -rs "ANTHROPIC_API_KEY?Anthropic API key: "
else
  read -rsp "Anthropic API key: " ANTHROPIC_API_KEY
fi
printf '\\n'
export ANTHROPIC_API_KEY
very-happy doctor`;
export const PUBLIC_COMMAND_PROOF_EVENT = 'vh:public-command-proof-open';

export type DocBlock =
  | { type: 'p'; text: string }
  | { type: 'code'; code: string }
  | { type: 'list'; items: string[] }
  | { type: 'link'; href: string; label: string }
  | { type: 'note'; text: string };

export type DocSection = { heading: string; blocks: DocBlock[] };
export type PublicDoc = {
  slug: string;
  label: string;
  summary: string;
  sections: DocSection[];
};

export const PUBLIC_DOCS: PublicDoc[] = [
  {
    slug: 'quickstart', label: 'Quick start', summary: 'Connect one machine, then use the Web/PWA as your daily workspace.',
    sections: [
      { heading: 'Recommended way to work', blocks: [
        { type: 'p', text: 'Treat the Web or installable PWA as the product surface you use every day. The CLI is the machine-side companion: install it once, pair the machine, start the background daemon, and return to it for diagnostics, automation, or an intentional local launch.' },
        { type: 'note', text: 'The Web still needs a connected daemon to reach local processes and files. “Web first” means the browser is the default interface, not that the machine-side CLI is optional.' },
      ] },
      { heading: 'Fast path: one command', blocks: [
        { type: 'p', text: 'On macOS or Linux, the Cloud bootstrap installs one exact published CLI version, runs local diagnostics, opens the normal one-time Web approval, and starts the detached machine daemon.' },
        { type: 'code', code: BOOTSTRAP_COMMAND },
        { type: 'note', text: 'The command downloads the complete script to a random temporary file before execution and removes it afterward. Review the version-controlled install.sh before running remote code; hosted bytes can change with a Web release. It never invokes sudo, installs tmux, writes provider credentials, or enables optional Claude hooks. Run the downloaded script with --dry-run for an offline, no-mutation command preview. If you add a structured Claude credential afterward, restart the daemon so it inherits the new environment. Windows, self-hosted endpoints, and users who prefer explicit control should follow the manual steps below.' },
      ] },
      { heading: '1. Choose a relay', blocks: [
        { type: 'p', text: 'Use Very Happy Cloud at veryhappy.dev for the shortest path, or deploy your own relay first. A browser account and every connected CLI must use the same relay.' },
        { type: 'note', text: 'Very Happy Cloud is the fastest path. Self-hosting gives you control of the operator, access policy, storage, backups, and upgrades. Read Security & privacy when choosing a deployment for sensitive work.' },
      ] },
      { heading: '2. Check the machine', blocks: [
        { type: 'list', items: ['Required: Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm.', 'Structured Claude: the CLI bundles the Agent SDK; configure Claude provider credentials for the daemon user. Native Claude terminal/mirror, Codex, Gemini, OpenCode, and OpenClaw need their local command or gateway.', 'Recommended: tmux keeps Web terminals alive across browser disconnects. Without it, terminals use a non-durable direct shell.', 'Optional Claude terminal mirror: tmux 3.2 or newer. The normal structured Claude path does not require tmux or hooks.'] },
        { type: 'code', code: 'node --version\ntmux -V            # recommended; may be absent\nclaude --version  # or codex / gemini / opencode / openclaw' },
        { type: 'note', text: 'The CLI bundles ripgrep and difftastic on supported platforms. Provider credentials stay agent-local by default. If you explicitly run very-happy connect, the selected OpenAI, Anthropic, or Gemini OAuth credential is stored on your chosen deployment so Web-launched integrations can use it; this is currently used primarily by the Gemini path.' },
      ] },
      { heading: '3. Configure Claude credentials', blocks: [
        { type: 'p', text: 'Very Happy bundles the Claude Agent SDK, not Claude usage or a Claude account. For structured sessions, configure ANTHROPIC_API_KEY or a supported Bedrock, Vertex AI, or Foundry environment for the same OS user and startup environment that runs the daemon.' },
        { type: 'code', code: PROVIDER_KEY_COMMAND },
        { type: 'note', text: 'Doctor reports only the source category captured from the daemon, never the credential value. A service manager needs the credential in its own secret store or private environment file. Restart the daemon after changing credentials; exporting a value in an unrelated shell does not update an already-running service. The normal path keeps provider credentials local. very-happy connect is a separate relay-upload flow and is not required here.' },
      ] },
      { heading: '4. Create an account', blocks: [
        { type: 'p', text: 'Create an account with an email verification code (the recommended default), Google, or—when the relay enables it—a username and password. Registration may be closed, invite-only, or at capacity; existing accounts can still sign in when registration is paused.' },
        { type: 'p', text: 'On a phone or tablet, the site proactively offers to install Very Happy on your Home Screen. Android/Chromium opens its native install dialog after you tap Install; iPhone/iPad and browsers without that event show Share/browser-menu instructions. The same responsive UI remains available without installing.' },
      ] },
      { heading: '5. Connect a machine', blocks: [
        { type: 'code', code: `${INSTALL_COMMAND}\nvery-happy doctor\n${LOGIN_COMMAND}` },
        { type: 'p', text: 'The CLI opens a one-time browser approval page. Confirm it only if you started the command on the machine in front of you. Public and non-loopback deployments should use HTTPS.' },
      ] },
      { heading: '6. Start the machine daemon', blocks: [
        { type: 'code', code: DAEMON_START_COMMAND },
        { type: 'p', text: 'This starts a detached background process. The machine appears in Web while its daemon is connected. Run it again after a reboot unless your service manager starts it automatically. Run very-happy daemon status to see the non-secret Claude credential source captured at daemon startup. Install tmux for durable Web terminals; tmux 3.2 or newer is required for the optional Claude terminal mirror. Without tmux, Web terminals use a non-persistent direct-shell fallback.' },
      ] },
      { heading: '7. Start work', blocks: [
        { type: 'p', text: 'Return to Web and choose New session on the connected machine. That is the recommended daily path. Start structured Claude through the bundled Agent SDK, or open a Web terminal for a real shell or ordinary xterm-256color-compatible text TUI such as vim, lazygit, ssh, or a database console. The raw terminal path is not tied to a coding agent.' },
        { type: 'note', text: 'The Web terminal is an xterm.js surface with TERM=xterm-256color. Most common text TUIs work, but terminal-specific graphics or extensions such as sixel and Kitty graphics are not a compatibility promise.' },
        { type: 'code', code: 'cd /path/to/your/project\nvery-happy          # local Claude TUI; requires external claude\nvery-happy codex    # Codex\nvery-happy gemini   # Gemini through ACP (beta)\nvery-happy acp opencode\nvery-happy openclaw # OpenClaw gateway\nvery-happy acp -- your-agent --agent-specific-acp-flag' },
        { type: 'p', text: 'Local CLI modes require their matching command or gateway. The beta Agent Client Protocol backend includes Gemini and OpenCode presets plus a generic runner; a custom command must expose a compatible ACP endpoint over stdio. OpenClaw uses its own local gateway protocol, not ACP. Run very-happy daemon status if the machine remains offline.' },
        { type: 'note', text: 'In a Web terminal, paste a clipboard image/file or drop a file to hand it to the selected machine. Terminal uploads are capped at 8 MB, staged under ~/.happy/uploads/terminal/, and return a path quoted for the daemon default shell at the cursor without pressing Enter. Larger uploads and native Windows path insertion require the current daemon.' },
      ] },
      { heading: 'Optional: mirror a hand-started Claude terminal', blocks: [
        { type: 'code', code: 'very-happy install-terminal-hooks\n# rollback\nvery-happy install-terminal-hooks --remove' },
        { type: 'p', text: 'SDK-backed Claude conversations work without this. The install command merges Very Happy SessionStart/SessionEnd entries into ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json) without removing foreign hooks. It only mirrors Claude started by hand inside a Very Happy Web terminal while the daemon is running.' },
      ] },
    ],
  },
  {
    slug: 'keyboard', label: 'Keyboard & touch', summary: 'Move between work, run commands, and keep native terminal shortcuts intact.',
    sections: [
      { heading: 'Command palette', blocks: [
        { type: 'p', text: 'Press Command K on macOS or Ctrl K on Windows and Linux to search actions, active chats, and terminals. Use Arrow Up and Arrow Down to move, Enter to run, and Escape to close. Session #tag filters use the same grammar as sidebar search.' },
        { type: 'list', items: ['Create a chat or terminal, including a terminal in a chosen directory.', 'Jump to a chat or terminal by name, machine, path, or session tag.', 'Open the voice assistant, clipboard history, notes, todo list, or settings.', 'On touch screens, tap the sidebar search button to open the same command palette without a hardware keyboard.'] },
        { type: 'note', text: 'The palette does not send terminal input. On macOS, application-level shortcuts use Command so Ctrl K, Ctrl J, Ctrl N, and Ctrl R remain available to readline and the real agent TUI.' },
      ] },
      { heading: 'High-value shortcuts', blocks: [
        { type: 'list', items: ['Command/Ctrl 1–9: switch to the corresponding visible sidebar row while the sidebar is mounted.', 'Command/Ctrl .: open saved shortcuts in the current chat or terminal; while open, 1–9 selects a preset.', 'Command/Ctrl J: toggle the notes panel from workspace routes.', 'Command/Ctrl R: rename the current chat or terminal when its visible sidebar row is mounted; otherwise the browser keeps Reload.', 'Command [ on macOS, or Alt Left Arrow outside an editable field: go back.', 'Command N in the installed macOS PWA, or Ctrl N on Windows/Linux outside editable and terminal input: create a terminal. Alt N is the browser-tab fallback outside editable fields.', 'Command W in the installed macOS PWA: close the current chat/terminal through the configured confirmation guard. Alt W is the cross-platform fallback; Ctrl W remains browser/window behavior.'] },
        { type: 'note', text: 'Browsers reserve Command/Ctrl N and Command/Ctrl W in normal tabs, so the page cannot reliably intercept them. Very Happy does not pretend otherwise: install the PWA for those native-feeling chords, or use the documented Alt fallback. On routes without a closable session, close shortcuts remain browser behavior.' },
      ] },
      { heading: 'Touch and mobile', blocks: [
        { type: 'p', text: 'Every keyboard-only workflow has a visible touch path: sidebar search for the command palette, header controls for files, notes and structured/terminal handoff, the New button for sessions, and Back controls plus edge swipe for navigation. The mobile terminal also exposes touch-first input controls rather than requiring a hardware keyboard.' },
        { type: 'p', text: 'Installing as a PWA removes browser chrome and makes browser-reserved application chords available where the operating system delivers them. Installation is optional; the responsive Web UI remains fully usable in a normal tab.' },
      ] },
    ],
  },
  {
    slug: 'cli', label: 'CLI & daemon', summary: 'Connect and operate the machine-side companion to the Web/PWA workspace.',
    sections: [
      { heading: 'Role in the product', blocks: [
        { type: 'p', text: 'The Web/PWA is the recommended daily interface. The CLI pairs a machine, starts and diagnoses the background daemon, launches local agent modes when you explicitly want them, and exposes automation commands. It is not a second UI you must live in.' },
      ] },
      { heading: 'Install', blocks: [
        { type: 'p', text: 'Very Happy requires Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+, with npm. Durable Web terminals additionally require tmux; version 3.2 or newer is required for the optional Claude mirror. Windows or another environment without tmux uses a non-persistent direct-shell fallback. Install the published CLI globally:' },
        { type: 'code', code: `${INSTALL_COMMAND}\nvery-happy doctor` },
        { type: 'p', text: 'Doctor reports the active relay and approval UI, Node version, tmux capability, bundled Claude SDK, visible external agent commands, authentication, and daemon state. A missing tmux is an explicit degraded mode, not an authentication failure.' },
      ] },
      { heading: 'Authenticate', blocks: [
        { type: 'code', code: LOGIN_COMMAND },
        { type: 'p', text: 'The command prints a short-lived approval URL. Only approve it when you started the command yourself on a machine you trust.' },
      ] },
      { heading: 'Operate', blocks: [
        { type: 'code', code: 'very-happy daemon status\nvery-happy daemon start\nvery-happy daemon stop' },
        { type: 'p', text: 'The daemon must be online for remote actions. Web-created structured Claude uses the bundled Agent SDK plus provider credentials. Install each external/local agent path you intend to run and keep its command or gateway resolvable for the daemon user. Codex has a dedicated mode, OpenClaw uses its gateway, and beta ACP covers Gemini, OpenCode, and compatible custom commands.' },
      ] },
      { heading: 'Optional Claude terminal mirror', blocks: [
        { type: 'code', code: 'very-happy install-terminal-hooks\nvery-happy install-terminal-hooks --remove' },
        { type: 'p', text: 'The first command adds only Very Happy SessionStart/SessionEnd entries to ~/.claude/settings.json or $CLAUDE_CONFIG_DIR/settings.json. It enables the structured mirror for a hand-started Claude process inside a Very Happy Web terminal while the daemon runs. The --remove form removes only those entries. Normal SDK-backed Claude sessions do not require the hooks.' },
      ] },
    ],
  },
  {
    slug: 'cloud', label: 'Very Happy Cloud', summary: 'Understand the hosted public relay, registration policy, and operational boundary.',
    sections: [
      { heading: 'What Cloud provides', blocks: [
        { type: 'p', text: 'veryhappy.dev hosts the web client, account service, sync storage, and relay. It is convenient for trying Very Happy without operating a server.' },
        { type: 'list', items: ['Public registration can be open, invite-only, paused, or capped globally.', 'No uptime or durability SLA is promised for the community service.', 'The operator can access relay-held content and account recovery material.'] },
      ] },
      { heading: 'When to self-host', blocks: [
        { type: 'p', text: 'Self-host when you need your own access policy, retention controls, network boundary, or operator trust. Self-hosting moves trust to your operator; it does not make the protocol end-to-end encrypted.' },
      ] },
    ],
  },
  {
    slug: 'self-hosting', label: 'Self-hosting', summary: 'Run a relay you control and point the web client and CLI at it.',
    sections: [
      { heading: 'Deployment shape', blocks: [
        { type: 'p', text: 'Deploy happy-server behind HTTPS and persist /data. Before serving, the Docker image migrates embedded PGlite by default or an explicitly configured external Postgres database. Set an explicit signup policy and account cap before exposing it.' },
        { type: 'code', code: "git clone https://github.com/Mereithhh/very-happy.git\ncd very-happy\ndocker build -t very-happy-server -f Dockerfile.server .\ndocker volume create very-happy-data\ndocker run -d --name very-happy-server --restart unless-stopped \\\n  -p 127.0.0.1:3005:3005 \\\n  -e HANDY_MASTER_SECRET='<high-entropy-secret>' \\\n  -e SIGNUP_MODE=invite -e SIGNUP_INVITE_CODES='<bootstrap-code>' \\\n  -e SIGNUP_MAX_ACCOUNTS=10 -v very-happy-data:/data very-happy-server\ncurl -fsS http://127.0.0.1:3005/health" },
        { type: 'note', text: 'Register the first operator with the bootstrap code, then recreate the container with SIGNUP_MODE=closed and without SIGNUP_INVITE_CODES. A plain docker restart keeps the old environment. Invite codes are not consumed automatically. Keep the service loopback-only until HTTPS and proxy trust are configured.' },
        { type: 'link', href: `${GITHUB_URL}/blob/main/docs/deployment.md`, label: 'Open the complete deployment and environment guide ↗' },
      ] },
      { heading: 'Loopback evaluation', blocks: [
        { type: 'p', text: 'Use the Docker shape above, bound to 127.0.0.1, for local evaluation. Do not install the upstream-owned happy-server-self-host package: it serves a different product build. The very-happy-server workspace package is intentionally private while its Prisma build tooling is not an approved public production dependency surface.' },
      ] },
      { heading: 'Connect a CLI', blocks: [
        { type: 'code', code: 'export HAPPY_HOME_DIR="$HOME/.very-happy-relay.example.com"\nexport HAPPY_SERVER_URL=https://relay.example.com\nexport HAPPY_WEBAPP_URL=https://relay.example.com\nvery-happy auth login\nvery-happy daemon start' },
        { type: 'note', text: 'Use a separate HAPPY_HOME_DIR for each relay and keep all three variables in the environment that starts the daemon. Tokens and machine IDs are relay-specific; use auth login --force only when intentionally replacing an existing home. Use HTTPS in production.' },
      ] },
      { heading: 'Production operations', blocks: [
        { type: 'p', text: 'Back up persistent volumes, pin versions, health-check the server, and rehearse rollback before upgrades. Configure only the login providers you operate; never disable password login until a real email-code or Google login has passed.' },
      ] },
    ],
  },
  {
    slug: 'configuration', label: 'Configuration', summary: 'Keep web, relay, and daemon endpoints and policies aligned.',
    sections: [
      { heading: 'Client endpoints', blocks: [
        { type: 'list', items: ['Cloud users need no endpoint variables; both client URLs default to https://veryhappy.dev.', 'HAPPY_SERVER_URL selects the API and socket relay for the CLI.', 'HAPPY_WEBAPP_URL selects the browser origin opened for machine approval.', 'HAPPY_HOME_DIR selects machine-local credentials, settings, logs, and daemon state.', 'VH_SERVER_URL selects the Vite development proxy target for Web V2.'] },
        { type: 'code', code: 'export HAPPY_HOME_DIR="$HOME/.very-happy-happy.example.com"\nexport HAPPY_SERVER_URL=https://happy.example.com\nexport HAPPY_WEBAPP_URL=https://happy.example.com\nvery-happy doctor' },
        { type: 'note', text: 'The daemon inherits its environment at startup. Provider credentials and agent commands must be available to the daemon OS user and PATH by default. Running very-happy connect is an explicit exception: it uploads the chosen OAuth credential to the trusted relay.' },
        { type: 'p', text: 'OpenClaw reads OPENCLAW_GATEWAY_URL plus OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD when set, or queries an already configured local openclaw command. Its paired device identity stays on the machine under $HAPPY_HOME_DIR/openclaw with private permissions.' },
      ] },
      { heading: 'Claude credentials', blocks: [
        { type: 'p', text: 'Structured Claude uses the bundled Agent SDK but still needs a provider account. The recommended third-party setup is ANTHROPIC_API_KEY, Amazon Bedrock, Google Vertex AI, or Microsoft Foundry, configured in the daemon startup environment. Very Happy does not broker Claude.ai login.' },
        { type: 'list', items: ['Claude API: ANTHROPIC_API_KEY.', 'Bedrock: normal AWS credentials plus CLAUDE_CODE_USE_BEDROCK=true.', 'Vertex AI: normal Google Cloud credentials plus CLAUDE_CODE_USE_VERTEX=true.', 'Foundry: normal Azure credentials plus CLAUDE_CODE_USE_FOUNDRY=true.', 'Existing apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN, or local Claude credential files may be detected; current Anthropic policy still applies. OS-keychain credentials are not inspected.'] },
        { type: 'code', code: 'very-happy daemon stop\nvery-happy daemon start\nvery-happy doctor\nvery-happy daemon status' },
        { type: 'note', text: 'Doctor prints source categories only. If the current process sees a source but daemon status does not, fix the service-manager secret/environment and restart. If the source is present but a session is rejected, validate provider account, region, model access, and billing as the daemon OS user.' },
        { type: 'link', href: `${GITHUB_URL}/blob/main/docs/configuration.md#claude-credentials-for-structured-sessions`, label: 'Open provider and service-manager details ↗' },
      ] },
      { heading: 'Account policy', blocks: [
        { type: 'p', text: 'The server controls email-code, password, and Google registration, invite requirements, global account capacity, and rate limits. SIGNUP_MODE defaults to closed; opening registration must be explicit. Set SIGNUP_MAX_ACCOUNTS to a small reviewed capacity on a public relay.' },
        { type: 'list', items: ['HANDY_MASTER_SECRET protects server-held account recovery and service secrets.', 'SIGNUP_MODE / SIGNUP_MAX_ACCOUNTS / SIGNUP_INVITE_CODES control registration.', 'MAX_MACHINES_PER_ACCOUNT, MAX_SESSIONS_PER_ACCOUNT, message, attachment, artifact, and KV limits bound stored data.', 'SOCKET_MAX_PAYLOAD_BYTES, RPC limits, and TERMINAL_RELAY_* token buckets bound realtime relay traffic.'] },
      ] },
      { heading: 'Operations and metrics', blocks: [
        { type: 'p', text: 'Metrics are disabled unless METRICS_ENABLED=true and bind to 127.0.0.1 by default. Set METRICS_HOST only for a protected scrape network; do not publish port 9090 to the Internet. Database, S3, Redis, proxy trust, and Google OAuth settings are documented in the complete configuration reference.' },
        { type: 'link', href: `${GITHUB_URL}/blob/main/docs/configuration.md`, label: 'Open every server and CLI variable ↗' },
      ] },
      { heading: 'Secrets', blocks: [
        { type: 'p', text: 'Keep master secrets, OAuth secrets, push credentials, and storage credentials outside Git. Use distinct values per environment and restrict access to backups and server logs.' },
      ] },
    ],
  },
  {
    slug: 'architecture', label: 'Architecture & data flow', summary: 'See which component owns identity, state, relay traffic, and execution.',
    sections: [
      { heading: 'Components', blocks: [
        { type: 'code', code: 'machine A daemon ─┐\nmachine B daemon ─┼─ trusted relay + storage ⇄ one Web / PWA account panel\nmachine C daemon ─┘                                  │\n                                             sessions / tasks / files\n                                             choose machine + agent' },
        { type: 'p', text: 'The browser is the unified command surface for every machine connected to the account. Its sidebar and board aggregate sessions and attention state across those machines; creating work explicitly targets a machine and agent. The server authenticates accounts, stores synchronized state, and relays socket traffic. Each daemon runs on its connected machine and exposes authorized remote capabilities.' },
      ] },
      { heading: 'Session flow', blocks: [
        { type: 'list', items: ['The user authenticates the browser to a relay.', 'A one-time approval connects a CLI identity to the same account.', 'The server routes requests and updates between browser and online daemon.', 'The daemon invokes local terminal or agent processes and streams results back.'] },
      ] },
      { heading: 'Structured and native terminal paths', blocks: [
        { type: 'p', text: "Upstream Happy's core Claude flow is an SDK-backed structured session. Very Happy keeps that path and, when tmux is installed, also carries the actual TTY from a process on the user's machine. The terminal transport is agent-neutral: a shell, vim, lazygit, ssh, database console, ordinary xterm-256color-compatible text TUI, or agent CLI all use the same byte stream. The daemon carries pane output and input through the trusted relay, and xterm renders the terminal in the browser; it is not a screenshot or a browser reimplementation." },
        { type: 'list', items: ['SDK path: Claude Agent SDK events become structured messages, tools, diffs, permissions, usage, and resume state.', 'Terminal path: tmux keeps the real TTY/TUI alive across browser disconnects and supports reconnect, scrollback, search, files, and mobile input.', 'Fallback: without tmux, Web terminals are non-persistent direct shells; tmux 3.2 or newer is required for the optional Claude mirror.', 'Parity is not implied: a terminal-backed process does not automatically expose Claude-style structured messages or agent controls.'] },
      ] },
      { heading: 'Agent adapters', blocks: [
        { type: 'p', text: 'Claude Code and Codex have dedicated integration paths, and OpenClaw uses its own local gateway adapter. The beta Gemini/OpenCode adapter uses Agent Client Protocol over local stdio through the official SDK; it is distinct from the older Agent Communication Protocol that shares the ACP acronym. Custom ACP commands must implement a compatible Agent Client Protocol endpoint.' },
      ] },
      { heading: 'Optional terminal mirror', blocks: [
        { type: 'p', text: 'SDK-backed Claude sessions stream structured events directly. A hand-started Claude process inside a Very Happy Web terminal is different: the optional very-happy install-terminal-hooks command adds scoped SessionStart/SessionEnd entries so the daemon can bind that process to a structured shadow session and return to the same TUI. The --remove form rolls back only those entries. This mirror is Claude-specific.' },
      ] },
      { heading: 'Compatibility', blocks: [
        { type: 'p', text: 'Protocol changes are designed so older clients ignore new fields. Deploy server, web, and CLI versions according to the release notes when a change includes a compatibility matrix.' },
      ] },
    ],
  },
  {
    slug: 'integrations', label: 'Integrations & automation', summary: 'Connect IM, schedulers, and task systems without putting private policy in the core.',
    sections: [
      { heading: 'MCP handoffs into the Web workspace', blocks: [
        { type: 'p', text: 'Base managed Claude sessions receive change_title, copy_to_clipboard, open_preview, and report_progress. The managed Codex, Gemini, and ACP bridge exposes change_title, copy_to_clipboard, and open_preview. These handoffs let an agent turn local work into visible Web state instead of merely printing another terminal line.' },
        { type: 'list', items: ['Assistant/meta-agent variant only: sessions_list, session_read, session_send, session_spawn, session_kill, session_archive, terminals_list, terminal_read, terminal_send, memory_update, and journal_append.', 'Those assistant-only tools can mutate local sessions, terminals, memory, and journals. Treat the assistant and its prompt/tool permissions as a high-privilege machine control surface.'] },
        { type: 'code', code: 'claude mcp add --scope user very-happy-clipboard -- very-happy mcp' },
        { type: 'note', text: 'This --scope user registration gives every Claude session for that OS user copy_to_clipboard; it is not bound to a Very Happy Web terminal. The standalone very-happy mcp command does not add title, preview, progress, spawning, or provider routing, and it needs the local daemon. Tool availability varies by runner and is not a universal MCP promise.' },
      ] },
      { heading: 'The composition boundary', blocks: [
        { type: 'p', text: 'Very Happy keeps organization-specific integrations outside the core. Your adapter decides which messages are trusted, which machine and directory may run a task, and which agent to start. The product exposes generic HTTPS notifications and local authenticated CLI commands.' },
        { type: 'note', text: 'An IM message is untrusted input, not authorization. Use explicit sender and room allowlists, fixed directory mappings, least-privilege daemon users, and confirmation for destructive actions.' },
      ] },
      { heading: 'A deployment pattern', blocks: [
        { type: 'p', text: 'An IM adapter can accept an authorized task marker, invoke very-happy spawn through a local daemon in a fixed allowed workspace, forward completion or permission events to a configured conversation, and map an authorized quote-reply back through very-happy send. The contract is intentionally independent of any chat vendor.' },
        { type: 'note', text: 'The chat adapter and the Claude-powered Web/voice coordinator are separate extension paths today. The adapter does not require or pass through the coordinator. Execution follows the configured agent permission mode.' },
        { type: 'code', code: 'very-happy spawn --dir /allowed/project --prompt-file request.txt --json\nvery-happy send --session <id> --prompt-file reply.txt --json' },
        { type: 'link', href: `${GITHUB_URL}/blob/main/docs/channels.md`, label: 'Read the webhook, spawn, send, MCP, and todo-provider contracts ↗' },
      ] },
      { heading: 'Personal agent systems', blocks: [
        { type: 'p', text: 'A useful agent system separates durable operating rules from credentials and company-specific knowledge. Keep small, reviewable skills and routing policy in version control; render secrets only at runtime; connect them to Very Happy through documented adapters. We plan to publish a scrubbed reference kit, not a dump of a private operator environment.' },
      ] },
    ],
  },
  {
    slug: 'security', label: 'Security & privacy', summary: 'The real trust model, remote execution boundary, and operator responsibilities.',
    sections: [
      { heading: 'Server-trusted by design', blocks: [
        { type: 'p', text: 'The product uses a server-trusted architecture.' },
        { type: 'note', text: 'Very Happy is not end-to-end encrypted or zero-knowledge. A server operator—or an attacker controlling the server—can access relay-held content, recover account secrets, and influence requests sent to online daemons.' },
        { type: 'p', text: 'Use a relay only if you trust its operator and security posture. Self-hosting changes who you trust; it does not remove the trusted relay from the architecture.' },
      ] },
      { heading: 'Machine approval', blocks: [
        { type: 'list', items: ['Approve only a link generated by your own CLI command.', 'Treat a connected daemon as remote execution access to that user account.', 'Run the daemon with the least OS privilege needed and keep the host patched.', 'Disconnect machines and rotate credentials after suspected compromise.'] },
      ] },
      { heading: 'Data handling', blocks: [
        { type: 'p', text: 'Sessions, terminal traffic, account metadata, logs, attachments, notifications, and integration data may pass through or persist on the relay depending on the feature. Operators should document retention, backups, subprocessors, and incident response for their deployment.' },
        { type: 'p', text: 'Email-code login stores the normalized address on the trusted relay. The configured mail provider receives the destination, sender, and one-time code under that provider\'s own processing and retention terms.' },
        { type: 'p', text: 'A terminal file handoff traverses the trusted relay and lands on the selected machine under ~/.happy/uploads/terminal/. The current client caps each file at 8 MB, transfers bounded chunks, and only pastes a path quoted for the daemon default shell; it does not execute the file or press Enter. Native Windows path insertion requires the current daemon to distinguish cmd from PowerShell.' },
      ] },
    ],
  },
  {
    slug: 'accounts-and-quotas', label: 'Accounts & quotas', summary: 'Registration modes, capacity messages, rate limits, and account recovery.',
    sections: [
      { heading: 'Registration outcomes', blocks: [
        { type: 'list', items: ['At capacity: no new public account can be created; try later or self-host.', 'Registration paused: existing users may sign in; contact the operator for policy.', 'Invite required: enter an operator-provided invite before email, Google, or password registration.', 'Rate limited: stop retrying, wait, and try once later.'] },
      ] },
      { heading: 'Authentication', blocks: [
        { type: 'p', text: 'A deployment may offer passwordless email codes, Google, and optionally username/password. Email codes are preferred when a verified sender is configured. Google depends on an OAuth client for the exact web origin; password controls disappear when the operator disables that compatibility path.' },
        { type: 'note', text: 'Already have a password or Google account? Sign in with that method first, then open Settings → Account → Email sign-in and verify your address. An unlinked Email login on an open relay can create a separate Account; the same-looking Google address is never merged automatically.' },
      ] },
      { heading: 'Operator controls', blocks: [
        { type: 'p', text: 'Capacity is a global signup safety limit, not a usage entitlement. Separate machine, session, encrypted state, message, attachment, access-key, artifact, feed, KV, push-token, usage-report, socket, and RPC boundaries protect the relay. Persistent writers share database-backed account locks across HTTP and Socket.IO, so changing clients does not bypass a quota.' },
        { type: 'list', items: ['400: shorten or correct the rejected field or batch. Access-key envelopes must be canonical base64 and decode to at most 4096 bytes.', '413 / *_bytes_quota_exceeded: delete releasable stored data or ask the operator.', '429 / *_count_quota_exceeded: delete releasable records or ask the operator.', '429 / *_rate_quota_exceeded: stop retrying and wait for the one-minute window.'] },
        { type: 'note', text: 'Encrypted session/machine metadata is capped at 256 KiB and state at 512 KiB, with large writes charged in 64 KiB units. Feed and upload rows have independent account caps. An upload URL reserves bytes and one row; an uncompleted reservation and its object are reclaimed after the operator-configured TTL (60 minutes by default).' },
      ] },
    ],
  },
  {
    slug: 'upgrades', label: 'Upgrade & rollback', summary: 'Update safely while preserving protocol and daemon compatibility.',
    sections: [
      { heading: 'Before upgrading', blocks: [
        { type: 'list', items: ['Read release notes and compatibility matrices.', 'Back up persistent storage and record the current server, web, and CLI versions.', 'Run the package gates and a clean-install smoke test.', 'Prepare the exact previous artifacts or commit for rollback.'] },
      ] },
      { heading: 'Order', blocks: [
        { type: 'p', text: 'The usual order is server, then web, then CLI. A release spec may require a different compatible order. Restart daemons when server RPC registration or CLI code changed.' },
        { type: 'code', code: 'npm install -g very-happy-cli@<version>\nvery-happy daemon status' },
      ] },
      { heading: 'Rollback', blocks: [
        { type: 'p', text: 'Restore the prior web assets, server source or image, and CLI package. Prefer forward-compatible migrations; do not invent destructive down migrations during an incident.' },
      ] },
    ],
  },
  {
    slug: 'troubleshooting', label: 'Troubleshooting', summary: 'Recover from login, pairing, offline-machine, and service failures.',
    sections: [
      { heading: 'Cannot sign in or register', blocks: [
        { type: 'list', items: ['Check the relay health and your network before retrying.', 'For an invalid email code, request one new code and use only the latest message.', 'For capacity, closed, or invite messages, follow that policy instead of repeatedly submitting.', 'If Google fails, allow the popup once or use email/password sign-in when enabled.'] },
      ] },
      { heading: 'Machine does not appear', blocks: [
        { type: 'code', code: 'very-happy daemon status' },
        { type: 'list', items: ['Confirm the CLI and browser use the same relay.', 'Run very-happy auth login again and approve the newly generated link.', 'Verify the daemon PATH can resolve the tools you intend to run.', 'Restart the daemon after an upgrade, then reload the web app.'] },
      ] },
      { heading: 'Server unavailable', blocks: [
        { type: 'p', text: 'Do not loop on destructive actions. Preserve local work, check the relay health endpoint and operator status, and use the documented rollback if you operate the deployment.' },
      ] },
    ],
  },
  {
    slug: 'contributing', label: 'Contributing', summary: 'Build the supported Web V2, server, wire, and CLI paths from a clean checkout.',
    sections: [
      { heading: 'Supported development path', blocks: [
        { type: 'code', code: 'pnpm install --frozen-lockfile\npnpm -C packages/happy-wire build\npnpm -C packages/happy-web-v2 exec vitest run\npnpm -C packages/happy-web-v2 exec tsc --noEmit\npnpm -C packages/happy-web-v2 exec vite build' },
        { type: 'p', text: 'happy-web-v2 is the production client. The retained Expo/Tauri happy-app is an experimental seed for a possible future desktop client, not a supported frontend in this release.' },
      ] },
      { heading: 'Change discipline', blocks: [
        { type: 'list', items: ['Open a focused change with tests proportional to risk.', 'Write a spec before changing protocols, state models, storage semantics, or multiple packages.', 'Never commit credentials, private session data, generated homes, or production logs.', 'Preserve old-client compatibility and document deployment order.'] },
      ] },
      { heading: 'Attribution and license', blocks: [
        { type: 'p', text: 'Very Happy is a heavily modified fork of slopus/happy. Review the repository license, notices, and contribution guide before distributing a build or submitting a patch.' },
      ] },
    ],
  },
];

export function getPublicDoc(slug: string | undefined): PublicDoc | undefined {
  return PUBLIC_DOCS.find((doc) => doc.slug === slug);
}

let zhHansDocs: PublicDoc[] | null = null;

function buildZhHansDocs(): PublicDoc[] {
  return PUBLIC_DOCS.map((doc) => {
    const translated = PUBLIC_DOCS_ZH_HANS[doc.slug];
    if (!translated) return doc;
    return {
      ...doc,
      label: translated.label,
      summary: translated.summary,
      sections: doc.sections.map((section, sectionIndex) => {
        const translatedSection = translated.sections[sectionIndex];
        if (!translatedSection) return section;
        return {
          ...section,
          heading: translatedSection.heading,
          blocks: section.blocks.map((block, blockIndex): DocBlock => {
            const value = translatedSection.blocks[blockIndex];
            if (block.type === 'code' || value == null) return block;
            if (block.type === 'list') return Array.isArray(value) ? { ...block, items: value } : block;
            if (Array.isArray(value)) return block;
            if (block.type === 'link') return { ...block, label: value };
            return { ...block, text: value };
          }),
        };
      }),
    };
  });
}

export function getPublicDocs(language: string): PublicDoc[] {
  if (language !== 'zh-Hans') return PUBLIC_DOCS;
  zhHansDocs ??= buildZhHansDocs();
  return zhHansDocs;
}
