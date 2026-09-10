import { machineFsRead } from '@/sync/fsOps';
import { assembleFsFile, FS_PREVIEW_CHUNK_BYTES } from './fsPreviewModel';
export const FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export function readDownload(machineId: string, path: string, cancelled: () => boolean) {
    return assembleFsFile(offset => cancelled() ? Promise.resolve({ ok: false, code: 'cancelled', error: 'cancelled' }) : machineFsRead(machineId, path, { maxBytes: FS_PREVIEW_CHUNK_BYTES, allowBinary: true, offset }), { maxBytes: FILE_DOWNLOAD_MAX_BYTES });
}
export function downloadBytes(bytes: Uint8Array, path: string) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    const a = document.createElement('a'); a.href = url; a.download = path.split(/[\\/]/).pop() || 'download';
    document.body.append(a); a.click(); a.remove();
    // Safari must finish resolving the download URL before it is released.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
