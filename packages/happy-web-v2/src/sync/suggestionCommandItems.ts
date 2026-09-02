export interface CommandItem {
    command: string;
    description?: string;
}

export const IGNORED_COMMANDS = [
    'add-dir', 'agents', 'config', 'statusline', 'bashes', 'settings', 'cost', 'doctor',
    'exit', 'help', 'ide', 'init', 'install-github-app', 'memory', 'migrate-installer',
    'model', 'pr-comments', 'release-notes', 'resume', 'status', 'bug', 'review',
    'security-review', 'terminal-setup', 'upgrade', 'vim', 'permissions', 'hooks',
    'export', 'logout', 'login',
    // web-local command (B-282): the composer prepends its own /btw row; the
    // CLI's builtin (local-jsx, cannot run in SDK mode) must not show twice
    'btw',
];

const DEFAULT_COMMANDS: CommandItem[] = [
    { command: 'compact', description: 'Compact the conversation history' },
    { command: 'clear', description: 'Clear the conversation' },
    { command: 'mcp', description: 'Show connected MCP servers' },
    { command: 'skills', description: 'Show available skills' },
];

const COMMAND_DESCRIPTIONS: Record<string, string> = {
    compact: 'Compact the conversation history',
    help: 'Show available commands',
    clear: 'Clear the conversation',
    reset: 'Reset the session',
    export: 'Export conversation',
    debug: 'Show debug information',
    status: 'Show connection status',
    stop: 'Stop current operation',
    abort: 'Abort current operation',
    cancel: 'Cancel current operation',
};

export function buildCommandItems(
    slashCommands: readonly string[] = [],
    skills: readonly string[] = [],
): CommandItem[] {
    const commands: CommandItem[] = [...DEFAULT_COMMANDS];
    const seen = new Set(commands.map((item) => item.command));
    const skillNames = new Set(skills.map((raw) => raw.trim().replace(/^\/+/, '')).filter(Boolean));

    for (const raw of [...slashCommands, ...skills]) {
        const command = raw.trim().replace(/^\/+/, '');
        if (!command || IGNORED_COMMANDS.includes(command) || seen.has(command)) continue;
        seen.add(command);
        commands.push({
            command,
            description: COMMAND_DESCRIPTIONS[command] ?? (skillNames.has(command) ? 'Skill' : undefined),
        });
    }

    return commands;
}
