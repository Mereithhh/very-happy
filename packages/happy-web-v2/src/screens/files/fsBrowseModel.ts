/**
 * Pure helpers for the FsBrowser UI (sorting, hidden-file filtering, path
 * math, display formatting). No React / network imports — unit-tested.
 */
import type { FsEntry } from '@/sync/fsOps';

export type FsSortMode = 'name' | 'mtime';

/** Display order: directories always first, then the chosen key within each
 *  group — 'mtime' = newest first (entries without an mtime sink to the
 *  bottom, ties fall back to name), 'name' = locale name order. (The daemon
 *  pre-sorts for deterministic truncation, but the web owns display order.) */
export function sortFsEntries(entries: FsEntry[], mode: FsSortMode = 'name'): FsEntry[] {
    return [...entries].sort((a, b) => {
        const aDir = a.type === 'dir';
        const bDir = b.type === 'dir';
        if (aDir !== bDir) return aDir ? -1 : 1;
        if (mode === 'mtime') {
            const diff = (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
            if (diff !== 0) return diff;
        }
        return a.name.localeCompare(b.name);
    });
}

/** Read-side validation of the persisted sort mode (kept tolerant so a junk
 *  value degrades to the default instead of surprising the list). */
export function resolveFsSortMode(raw: unknown): FsSortMode {
    return raw === 'name' ? 'name' : 'mtime';
}

/** Hidden files (dotfiles) are returned by the daemon and filtered here. */
export function visibleFsEntries(entries: FsEntry[], showHidden: boolean): FsEntry[] {
    return showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
}

/** '/a/b' → '/a'; '/a' → '/'; '/' → null (nowhere further up). */
export function parentFsPath(path: string): string | null {
    if (path === '/' || path === '') return null;
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
}

export function joinFsPath(dir: string, name: string): string {
    return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export interface FsCrumb {
    label: string;
    path: string;
}

/** '/a/b/c' → [{/, /}, {a, /a}, {b, /a/b}, {c, /a/b/c}]. Non-absolute paths
 *  (e.g. the pre-normalization '~') become a single crumb. */
export function fsBreadcrumbs(path: string): FsCrumb[] {
    if (!path.startsWith('/')) return [{ label: path, path }];
    const crumbs: FsCrumb[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const seg of path.split('/')) {
        if (!seg) continue;
        acc += `/${seg}`;
        crumbs.push({ label: seg, path: acc });
    }
    return crumbs;
}

/** Human-readable byte size: 512 → "512 B", 2048 → "2.0 KB", … */
export function formatFsSize(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    for (const unit of units) {
        v /= 1024;
        if (v < 1024 || unit === 'TB') return `${v.toFixed(1)} ${unit}`;
    }
    return '';
}

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
};

/** MIME type when the file name looks like a browser-renderable image. */
export function imageMimeOf(name: string): string | null {
    const ext = name.split('.').pop()?.toLowerCase();
    if (!ext || ext === name) return null;
    return IMAGE_MIME[ext] ?? null;
}
