/**
 * B-961b: which uploaded attachment (by server `ref`) already sits on THIS
 * machine, and where.
 *
 * A `file` event carries only the ref; the wrapper downloads and stages the
 * bytes under `HAPPY_HOME/uploads/chat/<session>/`. Retrying or editing a
 * prompt with attachments re-sends the same refs, so without this map the
 * wrapper would fetch every file again — and, worse, could not tell whether the
 * file it is about to reference still exists. This map is the machine's own
 * record: ref → staged path. A hit whose file is gone is treated as missing;
 * the caller may then re-fetch the blob, and only a ref that can be resolved
 * neither way is reported as gone.
 *
 * The map is per session (10.22 KB worst case at 200 entries), written
 * atomically with mode 0600, and trimmed oldest-first — it is a cache, not a
 * ledger.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory, hardenPrivateFile } from './secureFiles';

export type MachineAttachment = {
    path: string;
    name: string;
    mimeType: string;
    size: number;
    /** epoch ms, for the trim. */
    at: number;
};

const MAX_ENTRIES = 200;

function safeSegment(value: string, fallback: string, maxLength: number): string {
    const sanitized = value
        .replace(/[^\w.\-]+/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, maxLength) || fallback;
    return sanitized === '.' || sanitized === '..' ? fallback : sanitized;
}

export function attachmentRegistryPath(happyHomeDir: string, sessionId: string): string {
    return join(happyHomeDir, 'attachments', `${safeSegment(sessionId, 'session', 100)}.json`);
}

type RegistryFile = Record<string, MachineAttachment>;

async function readRegistry(happyHomeDir: string, sessionId: string): Promise<RegistryFile> {
    try {
        const raw = await readFile(attachmentRegistryPath(happyHomeDir, sessionId), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return {};
        const out: RegistryFile = {};
        for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof ref !== 'string' || ref.length === 0) continue;
            const entry = value as Partial<MachineAttachment> | null;
            if (!entry || typeof entry.path !== 'string' || !entry.path) continue;
            out[ref] = {
                path: entry.path,
                name: typeof entry.name === 'string' ? entry.name : 'attachment',
                mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream',
                size: typeof entry.size === 'number' ? entry.size : 0,
                at: typeof entry.at === 'number' ? entry.at : 0,
            };
        }
        return out;
    } catch {
        return {};
    }
}

async function writeRegistry(happyHomeDir: string, sessionId: string, registry: RegistryFile): Promise<void> {
    const path = attachmentRegistryPath(happyHomeDir, sessionId);
    await ensurePrivateDirectory(join(happyHomeDir, 'attachments'));
    const entries = Object.entries(registry)
        .sort((a, b) => a[1].at - b[1].at)
        .slice(-MAX_ENTRIES);
    const temp = `${path}.${randomUUID().replace(/-/g, '')}.part`;
    try {
        await writeFile(temp, JSON.stringify(Object.fromEntries(entries)), { flag: 'wx', mode: 0o600 });
        await hardenPrivateFile(temp);
        await rename(temp, path);
        await hardenPrivateFile(path);
    } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
    }
}

// Writes for one session serialize; concurrent file events must not lose each
// other's entries (read-modify-write).
const writeChains = new Map<string, Promise<void>>();

function sessionKey(happyHomeDir: string, sessionId: string): string {
    return `${happyHomeDir}\u0000${sessionId}`;
}

/** The staged copy this machine already holds for `ref`, if it is still there. */
export async function lookupMachineAttachment(
    happyHomeDir: string,
    sessionId: string,
    ref: string,
): Promise<MachineAttachment | null> {
    if (!ref) return null;
    const registry = await readRegistry(happyHomeDir, sessionId);
    const entry = registry[ref];
    if (!entry) return null;
    const info = await stat(entry.path).catch(() => null);
    if (!info?.isFile()) return null;
    return { ...entry, size: info.size };
}

/** Remember the staged copy for `ref` (a no-op without a ref). */
export async function recordMachineAttachment(
    happyHomeDir: string,
    sessionId: string,
    ref: string | undefined,
    attachment: { path: string; name: string; mimeType: string; size: number },
): Promise<void> {
    if (!ref) return;
    const key = sessionKey(happyHomeDir, sessionId);
    const prior = writeChains.get(key) ?? Promise.resolve();
    const next = prior
        .catch(() => {})
        .then(async () => {
            const registry = await readRegistry(happyHomeDir, sessionId);
            registry[ref] = { ...attachment, at: Date.now() };
            await writeRegistry(happyHomeDir, sessionId, registry);
        });
    writeChains.set(key, next);
    try {
        await next;
    } finally {
        if (writeChains.get(key) === next) writeChains.delete(key);
    }
}

/** Test isolation: drop the in-process write chains. */
export function resetAttachmentRegistryForTests(): void {
    writeChains.clear();
}
