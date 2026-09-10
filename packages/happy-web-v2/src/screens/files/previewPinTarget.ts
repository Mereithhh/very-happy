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
