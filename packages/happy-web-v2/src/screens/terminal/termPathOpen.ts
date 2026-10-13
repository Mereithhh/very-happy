/**
 * Open a file the user pointed at (terminal path click, B-574①) through the
 * SAME entry chat's FilePathLink uses (`openFsPreview` → docks into the
 * page's workspace panel), after the daemon confirmed it is a regular file.
 * Spec: specs/2026-10-terminal-paths-and-quick-open.md D3.
 */
import { machineFsRead, type FsReadResult } from '@/sync/fsOps';
import { openFsPreview, type FsPreviewRequest } from '@/sync/filePreviewOpen';

export type PathOpenOutcome = 'opened' | 'missing' | 'directory';

export async function openVerifiedFile(
    req: { machineId: string; path: string; sessionId?: string },
    deps: {
        read: (machineId: string, path: string, opts: { maxBytes: number }) => Promise<FsReadResult>;
        open: (request: FsPreviewRequest) => void;
    } = { read: machineFsRead, open: openFsPreview },
): Promise<PathOpenOutcome> {
    const res = await deps.read(req.machineId, req.path, { maxBytes: 1 });
    if (!res.ok && (res.code === 'not-found' || res.code === 'invalid-path')) return 'missing';
    if (!res.ok && (res.code === 'not-a-file' || res.code === 'not-a-directory')) return 'directory';
    // ok, or a failure the viewer already explains (old daemon, timeout,
    // offline, permission) — open it and let the viewer show that state.
    deps.open({ sessionId: req.sessionId, machineId: req.machineId, path: req.path, mode: 'file' });
    return 'opened';
}

export const LINE_FLASH_CLASS = 'vh-line-flash';

/**
 * Best effort: once the docked viewer for `path` has rendered its Shiki code
 * (`.cv-shiki .line`), scroll line `line` into view and flash it. Gives up
 * silently after `timeoutMs` (markdown/image previews have no lines).
 * Returns a cancel function.
 */
export function revealPreviewLine(path: string, line: number, opts: { timeoutMs?: number; root?: ParentNode } = {}): () => void {
    if (typeof document === 'undefined' || !(line >= 1)) return () => {};
    const root = opts.root ?? document;
    const deadline = Date.now() + (opts.timeoutMs ?? 4000);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const attempt = () => {
        if (cancelled) return;
        for (const viewer of Array.from(root.querySelectorAll('.fsb-viewer'))) {
            const head = viewer.querySelector('.fsb-viewer-path');
            if (!head || (head.getAttribute('title') ?? head.textContent) !== path) continue;
            const lines = viewer.querySelectorAll('.cv-shiki .line');
            if (lines.length === 0) break;
            const el = lines[Math.min(line, lines.length) - 1] as HTMLElement;
            el.scrollIntoView({ block: 'center' });
            el.classList.add(LINE_FLASH_CLASS);
            setTimeout(() => el.classList.remove(LINE_FLASH_CLASS), 1600);
            return;
        }
        if (Date.now() < deadline) timer = setTimeout(attempt, 120);
    };
    attempt();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
}
