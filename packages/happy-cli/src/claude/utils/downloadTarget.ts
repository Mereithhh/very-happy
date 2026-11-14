/**
 * `open_preview(download: true)` 的目标检查（B-562，`specs/2026-10-file-download-delivery.md` D1）。
 *
 * 推送前确认目标是一个存在的普通文件——否则 web 端只会报 not-found / not-a-file，
 * 而 agent 以为已经交付了。下载时目录直接拒绝并告诉它先打包。
 *
 * B-938：普通预览原来不 stat（B-131），模型对着一个从没生成过的路径调用也拿到
 * 「已推送」，然后告诉用户「已打开预览」，用户点开才看到「路径不存在」。现在普通
 * 预览也走同一个 stat（`checkPreviewTarget`），不存在 / 是目录都不推送。
 *
 * 判定是纯函数（`downloadTargetVerdict`），stat 留在调用方。
 */
import { stat } from 'node:fs/promises';

/** Web 端单次下载上限（与 web `FILE_DOWNLOAD_MAX_BYTES` 一致：fs-read 分块拼进内存）。 */
export const WEB_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type DownloadTargetStat =
    | { kind: 'missing' }
    | { kind: 'directory' }
    | { kind: 'other' }
    /** stat failed for a reason other than ENOENT (EACCES, ELOOP, ENAMETOOLONG…). */
    | { kind: 'error'; code: string; message: string }
    | { kind: 'file'; size: number };

export interface DownloadTargetVerdict {
    /** 非 null = 不推送，值是给模型看的理由。 */
    error: string | null;
    /** 推送成功时附在工具结果里的提醒（超出 web 下载上限）。 */
    note: string | null;
}

export function downloadTargetVerdict(path: string, target: DownloadTargetStat): DownloadTargetVerdict {
    switch (target.kind) {
        case 'missing':
            return { error: `${path} does not exist; create the file first, then call open_preview again`, note: null };
        case 'directory':
            return {
                error: `${path} is a directory; the user can only download a single file. `
                    + 'Pack it first (e.g. `zip -r out.zip <dir>`) and call open_preview with the archive and download: true',
                note: null,
            };
        case 'other':
            return { error: `${path} is not a regular file`, note: null };
        case 'error':
            return { error: `cannot read ${path}: ${target.code} (${target.message})`, note: null };
        case 'file':
            return target.size > WEB_DOWNLOAD_MAX_BYTES
                ? {
                    error: null,
                    note: `Note: the file is ${(target.size / 1024 / 1024).toFixed(1)} MiB, above the 50 MiB web download limit, `
                        + 'so the user will see its size but cannot download it. Offer to compress it or split it into '
                        + 'parts under 50 MiB (e.g. `zip -s 45m`).',
                }
                : { error: null, note: null };
    }
}

export async function statDownloadTarget(path: string): Promise<DownloadTargetStat> {
    try {
        const s = await stat(path);
        if (s.isDirectory()) return { kind: 'directory' };
        if (!s.isFile()) return { kind: 'other' };
        return { kind: 'file', size: s.size };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // Only "does not exist" is a missing file; anything else is reported as-is.
        if (code === 'ENOENT') return { kind: 'missing' };
        return { kind: 'error', code: code ?? 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
    }
}

export async function checkDownloadTarget(path: string): Promise<DownloadTargetVerdict> {
    return downloadTargetVerdict(path, await statDownloadTarget(path));
}

/**
 * B-938: plain-preview verdict. Every refusal says nothing was shown, so the model does
 * not go on to tell the user "the preview is open".
 */
export function previewTargetVerdict(path: string, target: DownloadTargetStat): DownloadTargetVerdict {
    const notShown = 'Nothing was shown to the user, so do not tell them the preview is open.';
    switch (target.kind) {
        case 'missing':
            return {
                error: `${path} does not exist on this machine. ${notShown} `
                    + 'Generate the file first (or check the path: relative paths resolve against the session working directory), '
                    + 'then call open_preview again.',
                note: null,
            };
        case 'directory':
            return {
                error: `${path} is a directory; open_preview shows a single file. ${notShown} `
                    + 'Preview a file inside it, or zip it and call open_preview with the archive and download: true.',
                note: null,
            };
        case 'other':
            return { error: `${path} is not a regular file. ${notShown}`, note: null };
        case 'error':
            return { error: `cannot read ${path}: ${target.code} (${target.message}). ${notShown}`, note: null };
        case 'file':
            return { error: null, note: null };
    }
}

/** B-938: the single pre-push check for every open_preview entry (plain preview or download). */
export async function checkPreviewTarget(path: string, download: boolean): Promise<DownloadTargetVerdict> {
    const target = await statDownloadTarget(path);
    return download ? downloadTargetVerdict(path, target) : previewTargetVerdict(path, target);
}
