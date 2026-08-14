/**
 * useCurrentBindTarget — what a note created RIGHT NOW should bind to, derived
 * from the current route: the open chat session or the open web terminal.
 * Returns a full NoteBinding (with a display-title snapshot, so the chip keeps
 * rendering after the target is archived/closed) or null on neutral routes.
 */
import { useLocation } from 'react-router-dom';
import { useSession } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { getSessionName } from '@/utils/sessionUtils';
import type { NoteBinding } from '@/sync/notes';

export function useCurrentBindTarget(): NoteBinding | null {
    const location = useLocation();
    const sessionMatch = location.pathname.match(/^\/session\/([^/]+)/);
    const sessionId = sessionMatch?.[1] ?? '';
    const session = useSession(sessionId);
    const terminalMatch = location.pathname.match(/^\/terminal\/([^/]+)/);
    const machineId = terminalMatch?.[1];
    const tid = new URLSearchParams(location.search).get('tid');
    const terminals = useTerminalSessions((s) => s.terminals);

    if (sessionId) {
        return {
            kind: 'session',
            id: sessionId,
            title: session ? getSessionName(session) : sessionId.slice(0, 8),
        };
    }
    if (machineId && tid) {
        const term = terminals.find((x) => x.id === tid);
        return { kind: 'terminal', id: tid, machineId, title: term?.title ?? tid.slice(0, 8) };
    }
    return null;
}

/** Where a binding chip should navigate to. */
export function bindingHref(binding: NoteBinding): string {
    if (binding.kind === 'session') return `/session/${binding.id}`;
    return binding.machineId ? `/terminal/${binding.machineId}?tid=${binding.id}` : '/terminal';
}
