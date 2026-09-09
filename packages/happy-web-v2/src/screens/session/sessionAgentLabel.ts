/** Reported runner identity, deliberately independent of the selected model. */
export function sessionAgentLabel(flavor: string | null | undefined, unknown: string): string {
    const value = flavor?.trim();
    if (!value) return unknown;
    switch (value) {
        case 'claude': return 'Claude Code';
        case 'codex': return 'Codex';
        case 'pi':
        case 'pi-acp': return 'Pi';
        case 'terminal-mirror': return 'Terminal';
        default: return value;
    }
}
