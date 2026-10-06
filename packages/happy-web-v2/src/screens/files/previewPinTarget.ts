import type { FsPreviewRequest } from '@/sync/filePreviewOpen';
/** Pin only to a verified context; never reuse a different host's workspace. */
export function previewPinTarget(request: FsPreviewRequest, location: { pathname: string; search: string }, sessionMachine: (id: string) => string | undefined): string | null {
    const match = location.pathname.match(/^\/(session|terminal)\/([^/]+)\/?$/);
    let id: string | undefined;
    try { id = match ? decodeURIComponent(match[2]) : undefined; } catch { return null; }
    const same = match?.[1] === 'session' ? id && sessionMachine(id) === request.machineId : match?.[1] === 'terminal' && id === request.machineId && new URLSearchParams(location.search).has('tid');
    if (same) {
        const params = new URLSearchParams(location.search);
        params.set('panel', 'browse'); params.set('pinFile', request.path);
        return `${location.pathname}?${params}`;
    }
    if (request.sessionId && sessionMachine(request.sessionId) === request.machineId) {
        const params = new URLSearchParams({ panel: 'browse', pinFile: request.path });
        return `/session/${encodeURIComponent(request.sessionId)}?${params}`;
    }
    return null;
}

/**
 * B-526: a preview Claude pushed (`open_preview`) takes you to the session it
 * came from (Owner 2026-10-02: 「preview 弹出来的时候，自动跳转回 preview 的那个
 * 对话」) — the preview is about that conversation, and reading it over an
 * unrelated page left no way to answer it. Only pushes follow; a preview you
 * opened yourself never moves you. Already there, or the session is not in
 * this client's list → stay.
 */
export function previewFollowTarget(request: FsPreviewRequest, pathname: string, sessionKnown: (id: string) => boolean): string | null {
    if (!request.fromPush || !request.sessionId || !sessionKnown(request.sessionId)) return null;
    const match = pathname.match(/^\/session\/([^/]+)\/?$/);
    let current: string | undefined;
    try { current = match ? decodeURIComponent(match[1]) : undefined; } catch { current = undefined; }
    return current === request.sessionId ? null : `/session/${encodeURIComponent(request.sessionId)}`;
}

/**
 * Where an incoming preview docks as the resizable side panel instead of the
 * modal, so the user can keep chatting next to it (Owner 2026-10-05:「preview
 * 应该改成侧边栏的（可以 resize），这样可以边预览边聊天」).
 *
 * A push may dock into its verified source session (that is where B-526 sends
 * you anyway); a preview you opened yourself only docks into the context you
 * are already in — it never moves you. null → keep the modal fallback (/board,
 * unknown session, machine mismatch).
 */
export function previewDockTarget(request: FsPreviewRequest, location: { pathname: string; search: string }, sessionMachine: (id: string) => string | undefined): string | null {
    if (request.fromPush) return previewPinTarget(request, location, sessionMachine);
    return previewPinTarget({ ...request, sessionId: undefined }, location, sessionMachine);
}
