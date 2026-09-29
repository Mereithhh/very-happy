/**
 * B-512: every module the CLI loads with a dynamic `import()`.
 *
 * The entry (./index.ts) is a small stub and most of the CLI is imported on
 * demand, so a plain `--version` no longer proves that the bundle's module
 * graph loads (broken npm install, missing chunk, external ESM named-import
 * mismatch — iron rule 2). `very-happy --self-check` imports everything listed
 * here instead; the handover preflight, CI and release smoke run it.
 *
 * lazyModules.test.ts fails when an `import()` anywhere under src/ is missing
 * from this list — add new dynamic imports here in the same change.
 */
export const LAZY_MODULES: ReadonlyArray<readonly [name: string, load: () => Promise<unknown>]> = [
    // Entry
    ['main', () => import('@/main')],
    ['selfCheck', () => import('@/selfCheck')],
    // Subcommands (main.ts)
    ['api/api', () => import('@/api/api')],
    ['claude/claudeCliPath', () => import('@/claude/claudeCliPath')],
    ['claude/runClaude', () => import('@/claude/runClaude')],
    ['commands/agentHome', () => import('@/commands/agentHome')],
    ['commands/auth', () => import('@/commands/auth')],
    ['commands/auto', () => import('@/commands/auto')],
    ['commands/codexCommand', () => import('@/commands/codexCommand')],
    ['commands/connect', () => import('@/commands/connect')],
    ['commands/installPiTools', () => import('@/commands/installPiTools')],
    ['commands/installTerminalHooks', () => import('@/commands/installTerminalHooks')],
    ['commands/mcp', () => import('@/commands/mcp')],
    ['commands/piTerminal', () => import('@/commands/piTerminal')],
    ['commands/sandbox', () => import('@/commands/sandbox')],
    ['commands/send', () => import('@/commands/send')],
    ['commands/server', () => import('@/commands/server')],
    ['commands/sessions', () => import('@/commands/sessions')],
    ['commands/spawn', () => import('@/commands/spawn')],
    ['commands/teams', () => import('@/commands/teams')],
    ['commands/todo', () => import('@/commands/todo')],
    ['daemon/doctor', () => import('@/daemon/doctor')],
    ['daemon/install', () => import('@/daemon/install')],
    ['daemon/run', () => import('@/daemon/run')],
    ['daemon/uninstall', () => import('@/daemon/uninstall')],
    ['resume/handleResumeCommand', () => import('@/resume/handleResumeCommand')],
    ['ui/doctor', () => import('@/ui/doctor')],
    ['agent/acp', () => import('@/agent/acp')],
    ['gemini/runGemini', () => import('@/gemini/runGemini')],
    ['gemini/utils/config', () => import('@/gemini/utils/config')],
    ['openclaw/runOpenClaw', () => import('@/openclaw/runOpenClaw')],
    ['persistence', () => import('@/persistence')],
    // Deferred halves of the runners and clients
    ['api/apiMachine', () => import('@/api/apiMachine')],
    ['claude/runClaudeDeps', () => import('@/claude/runClaudeDeps')],
    ['claude/claudeLocal', () => import('@/claude/claudeLocal')],
    ['claude/claudeLocalLauncher', () => import('@/claude/claudeLocalLauncher')],
    ['claude/sdk', () => import('@/claude/sdk')],
    ['assistant/bootstrap', () => import('@/assistant/bootstrap')],
    ['agentHome', () => import('@/agentHome')],
    ['ui/ink/RemoteModeDisplay', () => import('@/ui/ink/RemoteModeDisplay')],
    // External packages imported on demand
    ['expo-server-sdk', () => import('expo-server-sdk')],
    ['ink', () => import('ink')],
    ['react', () => import('react')],
];
