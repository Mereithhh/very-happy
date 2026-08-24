import { appendFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const MAX_USER_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_USER_UPLOAD_CHUNK_BYTES = 96 * 1024;
const MAX_ACTIVE_UPLOADS = 8;
const UPLOAD_TTL_MS = 10 * 60 * 1000;

export interface UploadFileRequest {
    name: string;
    content: string;
    subdir?: string;
}

export interface UploadFileResponse {
    success: boolean;
    path?: string;
    pathQuoteStyle?: UploadPathQuoteStyle;
    size?: number;
    error?: string;
}

export type UploadPathQuoteStyle = 'posix' | 'powershell' | 'cmd';

export type UploadFileChunkRequest =
    | { action: 'start'; uploadId: string; name: string; totalSize: number; subdir?: string }
    | { action: 'append'; uploadId: string; offset: number; content: string }
    | { action: 'finish'; uploadId: string }
    | { action: 'abort'; uploadId: string };

interface ActiveUpload {
    tempPath: string;
    targetPath: string;
    totalSize: number;
    received: number;
    touchedAt: number;
}

function safeSegment(value: string | undefined, fallback: string, maxLength: number): string {
    const sanitized = (value || fallback).replace(/[^\w.\-]+/g, '_').slice(0, maxLength) || fallback;
    return sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

function safeFileName(value: string | undefined): string {
    const basename = ((value || 'file').split(/[/\\]/).pop() || 'file');
    return safeSegment(basename, 'file', 200);
}

function uniqueFileName(name: string, token: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0
        ? `${name.slice(0, dot)}-${token}${name.slice(dot)}`
        : `${name}-${token}`;
}

function decodeUploadBase64(content: string, maxBytes: number): Buffer {
    const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
    if (
        content.length > maxEncodedLength
        || content.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
    ) {
        throw new Error('Invalid upload payload');
    }
    const buffer = Buffer.from(content, 'base64');
    if (buffer.length > maxBytes || buffer.toString('base64') !== content) {
        throw new Error('Invalid upload payload');
    }
    return buffer;
}

function validateUploadId(value: string): string {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
        throw new Error('Invalid upload id');
    }
    return value;
}

function defaultPathQuoteStyle(): UploadPathQuoteStyle {
    if (process.platform !== 'win32') return 'posix';
    const shell = (process.env.COMSPEC || 'powershell.exe').toLowerCase();
    return shell.includes('powershell') || shell.includes('pwsh') ? 'powershell' : 'cmd';
}

export function createUploadFileHandlers(
    happyHomeDir: string,
    now: () => number = Date.now,
    pathQuoteStyle: UploadPathQuoteStyle = defaultPathQuoteStyle(),
) {
    const active = new Map<string, ActiveUpload>();
    let operationQueue: Promise<void> = Promise.resolve();

    const serialize = <TRequest, TResponse>(handler: (data: TRequest) => Promise<TResponse>) =>
        (data: TRequest): Promise<TResponse> => {
            const result = operationQueue.then(() => handler(data), () => handler(data));
            operationQueue = result.then(() => undefined, () => undefined);
            return result;
        };

    const removeActive = async (uploadId: string): Promise<void> => {
        const upload = active.get(uploadId);
        active.delete(uploadId);
        if (upload) await unlink(upload.tempPath).catch(() => {});
    };

    const sweepExpired = async (): Promise<void> => {
        const cutoff = now() - UPLOAD_TTL_MS;
        await Promise.all(
            [...active.entries()]
                .filter(([, upload]) => upload.touchedAt < cutoff)
                .map(([uploadId]) => removeActive(uploadId)),
        );
    };

    const sweepExpiredFiles = async (dir: string): Promise<void> => {
        const cutoff = now() - UPLOAD_TTL_MS;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries.map(async (entry) => {
            if (!entry.isFile() || !/^\..+\.[A-Za-z0-9_-]{8,80}\.part$/.test(entry.name)) return;
            const path = join(dir, entry.name);
            const fileStat = await stat(path).catch(() => null);
            if (fileStat && fileStat.mtimeMs < cutoff) await unlink(path).catch(() => {});
        }));
    };

    const uploadFileUnlocked = async (data: UploadFileRequest): Promise<UploadFileResponse> => {
        let tempPath: string | null = null;
        try {
            const buffer = decodeUploadBase64(data.content, MAX_USER_UPLOAD_BYTES);
            const dir = join(happyHomeDir, 'uploads', safeSegment(data.subdir, 'misc', 80));
            await mkdir(dir, { recursive: true });
            const name = safeFileName(data.name);
            const token = randomUUID().replace(/-/g, '').slice(0, 12);
            const target = join(dir, uniqueFileName(name, token));
            tempPath = join(dir, `.${name}.legacy_${randomUUID().replace(/-/g, '')}.part`);
            await writeFile(tempPath, buffer, { flag: 'wx' });
            await rename(tempPath, target);
            tempPath = null;
            return { success: true, path: target, pathQuoteStyle, size: buffer.length };
        } catch (error) {
            if (tempPath) await unlink(tempPath).catch(() => {});
            return { success: false, error: error instanceof Error ? error.message : 'Failed to upload file' };
        }
    };

    const uploadFileChunkUnlocked = async (data: UploadFileChunkRequest): Promise<UploadFileResponse> => {
        try {
            await sweepExpired();
            const uploadId = validateUploadId(data.uploadId);

            if (data.action === 'start') {
                if (!Number.isSafeInteger(data.totalSize) || data.totalSize < 0 || data.totalSize > MAX_USER_UPLOAD_BYTES) {
                    throw new Error(`File exceeds the ${MAX_USER_UPLOAD_BYTES / 1024 / 1024} MB upload limit`);
                }
                if (active.has(uploadId)) throw new Error('Upload id is already active');
                if (active.size >= MAX_ACTIVE_UPLOADS) throw new Error('Too many active uploads');

                const dir = join(happyHomeDir, 'uploads', safeSegment(data.subdir, 'misc', 80));
                await mkdir(dir, { recursive: true });
                await sweepExpiredFiles(dir);
                const name = safeFileName(data.name);
                const targetPath = join(dir, uniqueFileName(name, randomUUID().replace(/-/g, '').slice(0, 12)));
                const tempPath = join(dir, `.${name}.${uploadId}.part`);
                await writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' });
                active.set(uploadId, { tempPath, targetPath, totalSize: data.totalSize, received: 0, touchedAt: now() });
                return { success: true, size: 0 };
            }

            if (data.action === 'abort') {
                const upload = active.get(uploadId);
                if (!upload) return { success: true, size: 0 };
                await removeActive(uploadId);
                return { success: true, size: upload.received };
            }

            const upload = active.get(uploadId);
            if (!upload) throw new Error('Upload is not active or has expired');

            if (data.action === 'append') {
                if (!Number.isSafeInteger(data.offset) || data.offset !== upload.received) {
                    throw new Error('Upload chunk is out of order');
                }
                const chunk = decodeUploadBase64(data.content, MAX_USER_UPLOAD_CHUNK_BYTES);
                if (upload.received + chunk.length > upload.totalSize) {
                    throw new Error('Upload exceeds declared size');
                }
                await appendFile(upload.tempPath, chunk);
                upload.received += chunk.length;
                upload.touchedAt = now();
                return { success: true, size: upload.received };
            }

            if (data.action !== 'finish') throw new Error('Invalid upload action');
            if (upload.received !== upload.totalSize) throw new Error('Upload is incomplete');
            const tempStat = await stat(upload.tempPath);
            if (tempStat.size !== upload.totalSize) throw new Error('Upload size verification failed');
            await rename(upload.tempPath, upload.targetPath);
            active.delete(uploadId);
            return { success: true, path: upload.targetPath, pathQuoteStyle, size: upload.totalSize };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to upload file' };
        }
    };

    return {
        uploadFile: serialize(uploadFileUnlocked),
        uploadFileChunk: serialize(uploadFileChunkUnlocked),
    };
}
