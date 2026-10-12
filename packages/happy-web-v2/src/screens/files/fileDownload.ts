/**
 * Raw-byte file download over the existing `fs-read` RPC (B-447), plus the
 * pure policy behind B-562's download delivery
 * (`specs/2026-10-file-download-delivery.md` D3/D4).
 *
 * Bytes are assembled from ≤512 KB windows into memory, so downloads are capped
 * at 50 MiB. The policy helpers (file name, MIME, auto-download gate, failure
 * text) are pure and unit-tested; `createDownloadUrl`/`triggerDownload` are the
 * only DOM-touching parts.
 */
import { machineFsRead } from '@/sync/fsOps';
import type { FsFailure } from '@/sync/fsOps';
import { assembleFsFile, FS_PREVIEW_CHUNK_BYTES, type FsAssembleResult } from './fsPreviewModel';
import { formatFsSize } from './fsBrowseModel';

export const FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

export function readDownload(machineId: string, path: string, cancelled: () => boolean, onProgress?: (loaded: number, total: number) => void) {
    return assembleFsFile(offset => cancelled() ? Promise.resolve({ ok: false, code: 'cancelled', error: 'cancelled' }) : machineFsRead(machineId, path, { maxBytes: FS_PREVIEW_CHUNK_BYTES, allowBinary: true, offset }), { maxBytes: FILE_DOWNLOAD_MAX_BYTES, onProgress });
}

/** Basename for the saved file: no path separators or control characters. */
export function downloadFileName(path: string): string {
    const base = (path.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return base === '' || base === '.' || base === '..' ? 'download' : base;
}

/**
 * MIME for the download blob. Known document/archive/image types get their real
 * type so iOS Quick Look and "Save to Files" recognise them; everything else —
 * and in particular ACTIVE content (HTML, SVG, XML, JS) — is octet-stream:
 * a blob: URL carries this app's origin, and if a browser falls back to
 * opening it as a page, agent-written markup must never execute here.
 */
const DOWNLOAD_MIME: Record<string, string> = {
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/plain',
    log: 'text/plain',
    json: 'application/json',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
};
export function downloadMimeOf(path: string): string {
    const name = downloadFileName(path);
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    return DOWNLOAD_MIME[ext] ?? 'application/octet-stream';
}

export interface AutoDownloadEnv {
    /** `matchMedia('(pointer: coarse)').matches` */
    coarsePointer: boolean;
    /** `document.visibilityState === 'visible'` when the push arrived */
    visible: boolean;
    userAgent: string;
    /** `navigator.maxTouchPoints` (iPadOS reports a desktop UA) */
    maxTouchPoints: number;
}

/**
 * Whether a pushed download may start by itself (desktop only). Phones and iOS
 * never auto-download: after an async RPC the user activation is gone, iOS may
 * turn the blob into a new page, and an unrequested download on a phone is
 * exactly the interruption the Owner asked to avoid. The button always works.
 */
export function shouldAutoDownload(env: AutoDownloadEnv): boolean {
    if (!env.visible || env.coarsePointer) return false;
    if (/iPhone|iPad|iPod/i.test(env.userAgent)) return false;
    if (/Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1) return false; // iPadOS
    if (/Android/i.test(env.userAgent)) return false;
    return true;
}

export function currentAutoDownloadEnv(): AutoDownloadEnv {
    const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return {
        coarsePointer: coarse,
        visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0,
    };
}

export type DownloadFailure =
    | { kind: 'machine-unknown' }
    | { kind: 'machine-offline'; machine: string }
    | { kind: 'read'; result: Exclude<FsAssembleResult, { ok: true }> };

/** Human text for a failed download: what happened and what to do next. */
export function downloadFailureText(failure: DownloadFailure, zh: boolean): string {
    if (failure.kind === 'machine-unknown') {
        return zh ? '找不到这台机器，无法下载。' : 'This machine is not in your account, so the file cannot be downloaded.';
    }
    if (failure.kind === 'machine-offline') {
        return zh ? `机器 ${failure.machine} 不在线，上线后再下载。` : `${failure.machine} is offline. Download once it is back online.`;
    }
    const r = failure.result;
    if (r.code === 'too-large') return tooLargeText(r.size, zh);
    if (r.code === 'needs-upgrade') {
        return zh ? `这台机器的 daemon 版本过旧，无法分块读取 ${formatFsSize(r.size)} 的文件，请升级 CLI。`
            : `This machine's daemon is too old to read ${formatFsSize(r.size)} in chunks. Update the CLI.`;
    }
    if (r.code === 'chunk-failed') {
        const code = (r.failure as Partial<FsFailure>).code;
        if (code === 'not-found') return zh ? '文件已不存在（可能被移动或删除）。' : 'The file no longer exists (it may have been moved or deleted).';
        if (code === 'not-a-file') return zh ? '这不是一个文件。目录请让 agent 先打包成 zip。' : 'This is not a file. Ask the agent to zip a directory first.';
        if (code === 'permission-denied') return zh ? '没有读取这个文件的权限。' : 'No permission to read this file.';
        if (code === 'unsupported') return zh ? '机器不在线或 daemon 不支持读取文件。' : 'The machine is offline or its daemon cannot read files.';
        if (code === 'timeout') return zh ? '读取超时，请检查机器连接后重试。' : 'Reading timed out. Check the machine connection and retry.';
    }
    return zh ? '下载失败，请检查连接后重试。' : 'Download failed. Check the connection and retry.';
}

export function tooLargeText(size: number, zh: boolean): string {
    return zh
        ? `文件 ${formatFsSize(size)}，超过网页下载上限 50 MiB。可以让 agent 压缩，或分卷成小于 50 MiB 的几个文件（如 zip -s 45m）再发。`
        : `The file is ${formatFsSize(size)}, above the 50 MiB web download limit. Ask the agent to compress it or split it into parts under 50 MiB (e.g. zip -s 45m).`;
}

/** Wrap bytes as a blob URL (caller revokes it). */
export function createDownloadUrl(bytes: Uint8Array, path: string): string {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: downloadMimeOf(path) }));
}

/** Programmatic click on a temporary `<a download>`. May be ignored without a user gesture (iOS). */
export function triggerDownload(url: string, path: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName(path);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
}
