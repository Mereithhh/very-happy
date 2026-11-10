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

/* B-526's previewFollowTarget is gone: B-918's previewJumpTarget (below) decides moves. */

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

/** What the jump decision needs to know about the pushing session. */
export interface PreviewSourceInfo {
    machineId?: string;
    /** `archivedAt` set: a deliberately archived session (B-265). */
    archived: boolean;
    /** Shared WITH this account (B-619): read-only/driver view, not ours to jump into. */
    shared: boolean;
}

/** URL param marking a side-panel file that a push docked (the viewer then shows 「来自 …」). */
export const PIN_SOURCE_PARAM = 'pinSource';

/**
 * B-918: a preview pushed by ANOTHER session takes you to that session and
 * opens there (Owner 11-11:「在 session A preview session B 的东西…直接跳到对应的
 * session 去展示」). Before this, a push from B while you sat in A on the same
 * machine docked into A's side panel (previewPinTarget's "same machine" branch),
 * so B's file looked like A's.
 *
 * Returns the URL to push-navigate to, or null = do not jump (open here as
 * before): not a push, no source session (machine/terminal push), the source
 * is the session you are already in, or it is unknown / archived / shared.
 * Any non-session page (board, terminal, settings) counts as "elsewhere".
 */
export function previewJumpTarget(request: FsPreviewRequest, pathname: string, source: (id: string) => PreviewSourceInfo | undefined): string | null {
    if (!request.fromPush || !request.sessionId) return null;
    const info = source(request.sessionId);
    if (!info || info.archived || info.shared) return null;
    const match = pathname.match(/^\/session\/([^/]+)\/?$/);
    let current: string | undefined;
    try { current = match ? decodeURIComponent(match[1]) : undefined; } catch { current = undefined; }
    if (current === request.sessionId) return null;
    const base = `/session/${encodeURIComponent(request.sessionId)}`;
    // Dock into B's side panel only when B's machine is the one serving the
    // file; otherwise land on B and let the modal show it.
    if (info.machineId !== request.machineId) return base;
    return `${base}?${new URLSearchParams({ panel: 'browse', pinFile: request.path, [PIN_SOURCE_PARAM]: 'push' })}`;
}
