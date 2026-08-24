export const GITHUB_URL = 'https://github.com/Mereithhh/very-happy';
export const INSTALL_COMMAND = 'npm install -g very-happy-cli';
export const LOGIN_COMMAND = 'very-happy auth login';
export const DAEMON_START_COMMAND = 'very-happy daemon start';

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
    slug: 'quickstart', label: 'Quick start', summary: 'Install the CLI, connect a machine, and open your first session.',
    sections: [
      { heading: '1. Choose a relay', blocks: [
        { type: 'p', text: 'Use Very Happy Cloud at happy.mereith.com for the shortest path, or deploy your own relay first. A browser account and every connected CLI must use the same relay.' },
        { type: 'note', text: 'The relay is trusted infrastructure, not an end-to-end encrypted blind relay. Read Security & privacy before connecting a sensitive machine.' },
      ] },
      { heading: '2. Create an account', blocks: [
        { type: 'p', text: 'Create an account with Google or a username and password. Registration may be closed, invite-only, or at capacity; existing accounts can still sign in when registration is paused.' },
      ] },
      { heading: '3. Connect a machine', blocks: [
        { type: 'code', code: `${INSTALL_COMMAND}\n${LOGIN_COMMAND}\n${DAEMON_START_COMMAND}` },
        { type: 'p', text: 'Open the one-time browser link printed by the CLI, confirm the machine, then start and keep the daemon running. The machine appears in the web app when its relay connection is healthy. Install tmux for durable Web terminals; tmux 3.2 or newer is required for the optional Claude terminal mirror. Without tmux, Web terminals use a non-persistent direct-shell fallback.' },
      ] },
      { heading: '4. Start work', blocks: [
        { type: 'code', code: 'cd /path/to/your/project\nvery-happy          # Claude Code\nvery-happy codex    # Codex\nvery-happy gemini   # Gemini through ACP (beta)\nvery-happy acp opencode\nvery-happy openclaw # OpenClaw gateway\nvery-happy acp -- your-agent --agent-specific-acp-flag' },
        { type: 'p', text: 'Start Claude Code or Codex from the CLI, or connect through a configured local OpenClaw gateway. The beta Agent Client Protocol backend also includes Gemini and OpenCode presets plus a generic runner; a custom command must expose a compatible ACP endpoint over stdio, and its flags remain agent-specific. OpenClaw uses its own local gateway protocol, not ACP. You can also select the connected machine and create a session or terminal from Web. Run very-happy daemon status if the machine remains offline.' },
      ] },
      { heading: 'Optional: mirror a hand-started Claude terminal', blocks: [
        { type: 'code', code: 'very-happy install-terminal-hooks\n# rollback\nvery-happy install-terminal-hooks --remove' },
        { type: 'p', text: 'SDK-backed Claude conversations work without this. The install command merges Very Happy SessionStart/SessionEnd entries into ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json) without removing foreign hooks. It only mirrors Claude started by hand inside a Very Happy Web terminal while the daemon is running.' },
      ] },
    ],
  },
  {
    slug: 'cli', label: 'CLI & daemon', summary: 'Install, authenticate, operate, and diagnose the machine-side agent.',
    sections: [
      { heading: 'Install', blocks: [
        { type: 'p', text: 'Very Happy requires a current Node.js LTS release and npm. Durable Web terminals additionally require tmux; version 3.2 or newer is required for the optional Claude mirror. Windows or another environment without tmux uses a non-persistent direct-shell fallback. Install the published CLI globally:' },
        { type: 'code', code: INSTALL_COMMAND },
      ] },
      { heading: 'Authenticate', blocks: [
        { type: 'code', code: LOGIN_COMMAND },
        { type: 'p', text: 'The command prints a short-lived approval URL. Only approve it when you started the command yourself on a machine you trust.' },
      ] },
      { heading: 'Operate', blocks: [
        { type: 'code', code: 'very-happy daemon status\nvery-happy daemon start\nvery-happy daemon stop' },
        { type: 'p', text: 'The daemon must be online for remote actions. Install each agent CLI you intend to run and keep it resolvable on the daemon PATH. Claude Code is the default, Codex has a dedicated mode, and OpenClaw connects through its configured local gateway. The beta ACP backend provides Gemini and OpenCode presets plus a generic command mode; compatibility depends on the agent exposing ACP over stdio.' },
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
        { type: 'p', text: 'happy.mereith.com hosts the web client, account service, sync storage, and relay. It is convenient for trying Very Happy without operating a server.' },
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
        { type: 'code', code: "git clone https://github.com/Mereithhh/very-happy.git\ncd very-happy\ndocker build -t very-happy-server -f Dockerfile.server .\ndocker volume create very-happy-data\ndocker run -d --name very-happy-server --restart unless-stopped \\\n  -p 127.0.0.1:3005:3005 \\\n  -e HANDY_MASTER_SECRET='<high-entropy-secret>' \\\n  -e SIGNUP_MODE=closed -e SIGNUP_MAX_ACCOUNTS=10 \\\n  -v very-happy-data:/data very-happy-server\ncurl -fsS http://127.0.0.1:3005/health" },
        { type: 'link', href: `${GITHUB_URL}/blob/main/docs/deployment.md`, label: 'Open the complete deployment and environment guide ↗' },
      ] },
      { heading: 'Connect a CLI', blocks: [
        { type: 'code', code: 'HAPPY_SERVER_URL=https://relay.example.com \\\nHAPPY_WEBAPP_URL=https://relay.example.com \\\nvery-happy auth login' },
        { type: 'note', text: 'Use HTTPS in production. Configure allowed web origins and OAuth redirect origins explicitly; do not copy production credentials into a development deployment.' },
      ] },
      { heading: 'Production operations', blocks: [
        { type: 'p', text: 'Back up persistent volumes, pin versions, health-check the server, and rehearse rollback before upgrades. Disable Google sign-in when no OAuth client is configured; password accounts remain available.' },
      ] },
    ],
  },
  {
    slug: 'configuration', label: 'Configuration', summary: 'Keep web, relay, and daemon endpoints and policies aligned.',
    sections: [
      { heading: 'Client endpoints', blocks: [
        { type: 'list', items: ['HAPPY_SERVER_URL selects the API and socket relay for the CLI.', 'HAPPY_WEBAPP_URL selects the browser origin opened for machine approval.', 'VH_SERVER_URL selects the Vite development proxy target for Web V2.'] },
      ] },
      { heading: 'Account policy', blocks: [
        { type: 'p', text: 'The server controls password and Google registration, invite requirements, global account capacity, and rate limits. Prefer closed registration as the safe fallback if identity or abuse controls are unhealthy.' },
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
        { type: 'code', code: 'browser  ⇄  trusted relay + storage  ⇄  daemon  ⇄  local tools\n Web V2       happy-server              CLI       shell / coding agents' },
        { type: 'p', text: 'The browser handles the user interface. The server authenticates accounts, stores synchronized state, and relays socket traffic. The daemon runs on the connected machine and exposes authorized remote capabilities.' },
      ] },
      { heading: 'Session flow', blocks: [
        { type: 'list', items: ['The user authenticates the browser to a relay.', 'A one-time approval connects a CLI identity to the same account.', 'The server routes requests and updates between browser and online daemon.', 'The daemon invokes local terminal or agent processes and streams results back.'] },
      ] },
      { heading: 'Structured and native terminal paths', blocks: [
        { type: 'p', text: "Upstream Happy's core Claude flow is an SDK-backed structured session. Very Happy keeps that path and, when tmux is installed, also runs the actual agent CLI/TUI in a tmux-owned terminal on the user's machine. The daemon carries pane output and input through the trusted relay, and xterm renders the terminal in the browser; it is not a screenshot or a browser reimplementation of the agent interface." },
        { type: 'list', items: ['SDK path: Claude Agent SDK events become structured messages, tools, diffs, permissions, usage, and resume state.', 'Terminal path: tmux keeps the real TTY/TUI alive across browser disconnects and supports reconnect, scrollback, search, files, and mobile input.', 'Fallback: without tmux, Web terminals are non-persistent direct shells; tmux 3.2 or newer is required for the optional Claude mirror.', 'Parity is not implied: a terminal-backed agent does not automatically expose a Claude-style structured mirror.'] },
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
      { heading: 'The composition boundary', blocks: [
        { type: 'p', text: 'Very Happy keeps organization-specific integrations outside the core. Your adapter decides which messages are trusted, which machine and directory may run a task, and which agent to start. The product exposes generic HTTPS notifications and local authenticated CLI commands.' },
        { type: 'note', text: 'An IM message is untrusted input, not authorization. Use explicit sender and room allowlists, fixed directory mappings, least-privilege daemon users, and confirmation for destructive actions.' },
      ] },
      { heading: 'A real deployment pattern', blocks: [
        { type: 'p', text: 'Our private Tanka adapter accepts an authorized [happy] task, invokes very-happy spawn through a local daemon in a fixed allowed workspace, forwards completion or permission events to a configured notification conversation, and maps an authorized quote-reply there back through very-happy send. Tanka is one example; the contract is not tied to it.' },
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
      ] },
    ],
  },
  {
    slug: 'accounts-and-quotas', label: 'Accounts & quotas', summary: 'Registration modes, capacity messages, rate limits, and account recovery.',
    sections: [
      { heading: 'Registration outcomes', blocks: [
        { type: 'list', items: ['At capacity: no new public account can be created; try later or self-host.', 'Registration paused: existing users may sign in; contact the operator for policy.', 'Invite required: enter an operator-provided invite before Google or password registration.', 'Rate limited: stop retrying, wait, and try once later.'] },
      ] },
      { heading: 'Authentication', blocks: [
        { type: 'p', text: 'A deployment may offer username/password, Google sign-in, or both. Google availability depends on an OAuth client configured for the exact web origin. A popup cancellation does not create an account.' },
      ] },
      { heading: 'Operator controls', blocks: [
        { type: 'p', text: 'Capacity is a global signup safety limit, not a usage entitlement. Separate machine, session, message, attachment, socket, and RPC boundaries protect the relay. When a storage cap is reached, delete unneeded sessions or ask the operator; repeatedly retrying will not bypass it.' },
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
        { type: 'list', items: ['Check the relay health and your network before retrying.', 'For wrong credentials, verify the relay origin and account name.', 'For capacity, closed, or invite messages, follow that policy instead of repeatedly submitting.', 'If Google fails, allow the popup once or use password sign-in when enabled.'] },
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
        { type: 'p', text: 'happy-web-v2 is the production client. The legacy Expo happy-app remains only for upstream history and is not the supported frontend.' },
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
