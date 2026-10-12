/**
 * `open_preview(download: true)` 的目标检查（B-562，`specs/2026-10-file-download-delivery.md` D1）。
 *
 * 普通预览不 stat（保持 B-131 行为）；只有 agent 明说「用户要拿到这个文件」时，
 * 才在推送前确认它是一个存在的普通文件——否则 web 端只会报 not-found / not-a-file，
 * 而 agent 以为已经交付了。目录直接拒绝并告诉它先打包。
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
    } catch {
        return { kind: 'missing' };
    }
}

export async function checkDownloadTarget(path: string): Promise<DownloadTargetVerdict> {
    return downloadTargetVerdict(path, await statDownloadTarget(path));
}
