import type { RecentMachinePath } from './quickChat';

/** Only the route the user is viewing supplies context; a background running
 * session must never redirect creation to an unrelated project or machine. */
export function newChatLocation(
    location: { pathname: string; search?: string } | undefined,
    sessions: Record<string, { metadata?: { machineId?: string; path?: string } | null }>,
    terminals: readonly { id: string; machineId: string; cwd?: string }[],
): RecentMachinePath | undefined {
    if (!location) return;
    const match = location.pathname.match(/^\/(session|terminal)\/([^/]+)(?:\/|$)/);
    if (!match) return;
    let id: string;
    try { id = decodeURIComponent(match[2]); } catch { return; }
    if (match[1] === 'session') {
        const meta = sessions[id]?.metadata;
        return meta?.machineId ? { machineId: meta.machineId, path: meta.path ?? '' } : undefined;
    }
    const tid = new URLSearchParams(location.search).get('tid');
    const terminal = terminals.find(t => t.id === tid && t.machineId === id);
    return terminal ? { machineId: id, path: terminal.cwd ?? '' } : undefined;
}
