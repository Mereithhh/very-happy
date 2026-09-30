/**
 * B-512: V8 compile cache for the CLI's own modules.
 *
 * Every session wrapper is a fresh Node process that parses/compiles the same
 * bundle. `module.enableCompileCache(dir)` (Node >= 22.1; absent on older
 * runtimes, hence the guard) reuses the compiled code across processes. It does
 * NOT set `NODE_COMPILE_CACHE`, so the Claude / agent children we spawn do not
 * inherit a cache pointing into our home — we never set that variable either.
 *
 * Only enabled when the happy home already exists: creating it here (with
 * default permissions) would pre-empt configuration's private-directory setup.
 * One directory per CLI version (~10 MB each); the daemon prunes the others.
 */
import module from 'node:module';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function happyHomeDirFromEnv(env: NodeJS.ProcessEnv, home: string = homedir()): string {
    return env.HAPPY_HOME_DIR ? env.HAPPY_HOME_DIR.replace(/^~/, home) : join(home, '.happy');
}

export function compileCacheRoot(happyHomeDir: string): string {
    return join(happyHomeDir, 'cache', 'compile');
}

export function compileCacheDir(happyHomeDir: string, cliVersion: string): string {
    return join(compileCacheRoot(happyHomeDir), cliVersion.replace(/[^\w.+-]/g, '_'));
}

export function enableCompileCacheIfPossible(cliVersion: string, env: NodeJS.ProcessEnv = process.env): void {
    try {
        const enable = (module as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
        if (typeof enable !== 'function') return;
        const happyHome = happyHomeDirFromEnv(env);
        if (!existsSync(happyHome)) return;
        enable(compileCacheDir(happyHome, cliVersion));
    } catch {
        // A cache is an optimisation; never let it break startup.
    }
}

/** Remove compile caches of other CLI versions. Best effort; never throws. */
export async function pruneStaleCompileCaches(happyHomeDir: string, cliVersion: string): Promise<string[]> {
    const root = compileCacheRoot(happyHomeDir);
    const keep = compileCacheDir(happyHomeDir, cliVersion);
    const removed: string[] = [];
    let entries: string[];
    try {
        entries = await readdir(root);
    } catch {
        return removed;
    }
    for (const name of entries) {
        const dir = join(root, name);
        if (dir === keep) continue;
        try {
            await rm(dir, { recursive: true, force: true });
            removed.push(name);
        } catch {
            // an older process may still be writing into it; next start retries
        }
    }
    return removed;
}
