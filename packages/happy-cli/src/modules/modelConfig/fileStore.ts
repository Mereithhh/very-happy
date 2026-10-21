/**
 * B-688 file primitives for harness config edits: bounded read, atomic write
 * (temp file in the same directory → fsync → rename, symlinks written through
 * to their target), and a private backup store under the Very Happy home.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Harness configs are hand-edited text; anything bigger is not one we should rewrite. */
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_BACKUPS_PER_HARNESS = 20;

export interface ConfigFileState {
    /** Path as the harness resolves it (may be a symlink). */
    path: string;
    exists: boolean;
    content: string;
    /** sha256 of the content ('' content for a missing file hashes too). */
    hash: string;
    /** Permission bits of the existing file, or null. */
    mode: number | null;
}

export class ModelConfigError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'ModelConfigError';
    }
}

export function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

export async function readConfigFile(path: string): Promise<ConfigFileState> {
    let stat;
    try {
        stat = await fs.stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { path, exists: false, content: '', hash: sha256(''), mode: null };
        }
        throw new ModelConfigError('read-failed', `Cannot read ${path}: ${(error as Error).message}`);
    }
    if (!stat.isFile()) throw new ModelConfigError('not-a-file', `${path} is not a regular file`);
    if (stat.size > MAX_CONFIG_BYTES) throw new ModelConfigError('file-too-large', `${path} is larger than ${MAX_CONFIG_BYTES} bytes`);
    const content = await fs.readFile(path, 'utf8');
    return { path, exists: true, content, hash: sha256(content), mode: stat.mode & 0o777 };
}

/** Where a write to `path` should land: the symlink target if it is one, else `path`. */
async function resolveWriteTarget(path: string): Promise<string> {
    try {
        return await fs.realpath(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // A dangling symlink: write to its target path, never replace the link.
            try {
                const link = await fs.readlink(path);
                return link.startsWith('/') ? link : join(dirname(path), link);
            } catch {
                return path;
            }
        }
        throw error;
    }
}

/**
 * Atomic replace. `mode` defaults to the existing file's bits, or 0600 for a
 * new file (it may hold a key). The directory is created (0700) if missing.
 */
export async function atomicWriteFile(path: string, content: string, mode: number | null): Promise<void> {
    const target = await resolveWriteTarget(path);
    const dir = dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(target)}.vh-tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode ?? 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(tmp).catch(() => {});
        throw error;
    }
    await handle.close();
    try {
        if (mode !== null) await fs.chmod(tmp, mode);
        await fs.rename(tmp, target);
    } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
    }
    // Best effort: persist the rename itself.
    try {
        const dirHandle = await fs.open(dir, 'r');
        await dirHandle.sync().catch(() => {});
        await dirHandle.close();
    } catch {
        // not supported on every platform
    }
}

export interface BackupFile {
    path: string;
    /** null = the file did not exist before the change (restore deletes it). */
    content: string | null;
    mode: number | null;
}

export interface BackupEntry {
    id: string;
    createdAt: number;
    reason: string;
    files: string[];
}

const BACKUP_ID = /^\d{13}-[0-9a-f]{8}$/;
const HARNESS_DIR = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Backups live in `<happyHome>/model-config-backups/<harness>/<id>/` (dirs
 * 0700, files 0600) — never next to the harness config, so they neither
 * clutter `~/.claude` nor get picked up by the harness or a dotfile manager.
 */
export class BackupStore {
    constructor(private readonly root: string) {}

    private harnessDir(harness: string): string {
        if (!HARNESS_DIR.test(harness)) throw new ModelConfigError('invalid-harness', 'Invalid harness');
        return join(this.root, harness);
    }

    async create(harness: string, reason: string, files: BackupFile[], now = Date.now()): Promise<BackupEntry> {
        const id = `${now}-${randomBytes(4).toString('hex')}`;
        const dir = join(this.harnessDir(harness), id);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const manifest = { id, createdAt: now, reason, files: files.map((f, i) => ({ path: f.path, blob: f.content === null ? null : `f${i}`, mode: f.mode })) };
        for (const [i, file] of files.entries()) {
            if (file.content !== null) await fs.writeFile(join(dir, `f${i}`), file.content, { encoding: 'utf8', mode: 0o600 });
        }
        await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
        await this.prune(harness);
        return { id, createdAt: now, reason, files: files.map(f => f.path) };
    }

    async list(harness: string): Promise<BackupEntry[]> {
        let names: string[];
        try {
            names = await fs.readdir(this.harnessDir(harness));
        } catch {
            return [];
        }
        const entries: BackupEntry[] = [];
        for (const name of names.filter(n => BACKUP_ID.test(n))) {
            try {
                const manifest = JSON.parse(await fs.readFile(join(this.harnessDir(harness), name, 'manifest.json'), 'utf8'));
                entries.push({ id: name, createdAt: Number(manifest.createdAt) || 0, reason: String(manifest.reason ?? ''), files: (manifest.files ?? []).map((f: { path: string }) => f.path) });
            } catch {
                // half-written backup: skip
            }
        }
        return entries.sort((a, b) => b.createdAt - a.createdAt);
    }

    async read(harness: string, id: string): Promise<BackupFile[]> {
        if (!BACKUP_ID.test(id)) throw new ModelConfigError('invalid-backup', 'Invalid backup id');
        const dir = join(this.harnessDir(harness), id);
        let manifest: { files: { path: string; blob: string | null; mode: number | null }[] };
        try {
            manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8'));
        } catch {
            throw new ModelConfigError('backup-not-found', 'Backup not found');
        }
        const out: BackupFile[] = [];
        for (const file of manifest.files) {
            out.push({
                path: file.path,
                content: file.blob === null ? null : await fs.readFile(join(dir, file.blob), 'utf8'),
                mode: typeof file.mode === 'number' ? file.mode : null,
            });
        }
        return out;
    }

    private async prune(harness: string): Promise<void> {
        const entries = await this.list(harness);
        for (const stale of entries.slice(MAX_BACKUPS_PER_HARNESS)) {
            await fs.rm(join(this.harnessDir(harness), stale.id), { recursive: true, force: true });
        }
    }
}
