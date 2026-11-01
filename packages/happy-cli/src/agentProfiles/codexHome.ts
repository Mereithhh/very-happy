/**
 * B-850b: a ChatGPT account's CODEX_HOME overlay.
 *
 * Codex keeps ONE sign-in per home (`auth.json`), so a second ChatGPT account
 * needs its own home — but a different home loses the history (`thread/resume`
 * → "no rollout found", FEASIBILITY C3). The overlay owns only the per-account
 * and per-process state; everything else is a symlink into the base home, so
 * sessions / config / skills / AGENTS.md are the user's and resume keeps
 * working across a switch.
 *
 * Never linked: `auth.json` (copying or sharing it races the refresh token —
 * AGENTS #16), the sqlite state/log databases and their WAL files (each home
 * keeps its own index; Codex rebuilds it from the rollouts), caches, logs,
 * tmp and the app-server daemon socket dir.
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Pure: entries of the base home the overlay must NOT link. */
export function isOverlayLocal(name: string): boolean {
    if (name === 'auth.json' || name === '.credentials.json') return true;
    if (/\.sqlite(-shm|-wal|-journal)?$/.test(name)) return true;
    return ['log', 'logs', 'tmp', '.tmp', 'cache', 'models_cache.json', 'app-server-daemon', 'version.json', '.lock'].includes(name);
}

/** Linked even when the base home does not have it yet (Codex creates them on first use). */
const ALWAYS_LINKED_DIRS = ['sessions', 'archived_sessions'];

export type OverlayFs = {
    list: (dir: string) => string[];
    /** null = missing; 'link' with its target; or 'other' (a real file / dir). */
    entry: (path: string) => { type: 'link'; target: string } | { type: 'other' } | null;
    mkdir: (dir: string) => void;
    symlink: (target: string, path: string) => void;
    rename: (from: string, to: string) => void;
    remove: (path: string) => void;
};

export const nodeOverlayFs: OverlayFs = {
    list: (dir) => {
        try {
            return readdirSync(dir);
        } catch {
            return [];
        }
    },
    entry: (path) => {
        try {
            const st = lstatSync(path);
            return st.isSymbolicLink() ? { type: 'link', target: readlinkSync(path) } : { type: 'other' };
        } catch {
            return null;
        }
    },
    mkdir: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
    symlink: (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : undefined),
    rename: renameSync,
    remove: (path) => rmSync(path, { force: true }),
};

/**
 * (Re)link the overlay to `baseHome`. Idempotent; run before every app-server
 * start so entries the user adds to ~/.codex later show up. An entry Codex
 * replaced with a real file (an atomic rewrite of a linked config.toml) is
 * kept aside as `<name>.overlay-<now>` — never deleted — and relinked.
 * Returns the names it changed.
 */
export function syncCodexOverlay(overlay: string, baseHome: string, now: number, fs: OverlayFs = nodeOverlayFs): string[] {
    fs.mkdir(overlay);
    for (const dir of ALWAYS_LINKED_DIRS) fs.mkdir(join(baseHome, dir));
    const names = new Set([...fs.list(baseHome), ...ALWAYS_LINKED_DIRS]);
    const changed: string[] = [];
    for (const name of names) {
        if (isOverlayLocal(name) || name.includes('.overlay-')) continue;
        const target = join(baseHome, name);
        const path = join(overlay, name);
        const current = fs.entry(path);
        if (current?.type === 'link' && current.target === target) continue;
        if (current?.type === 'link') fs.remove(path);
        else if (current?.type === 'other') fs.rename(path, `${path}.overlay-${now}`);
        fs.symlink(target, path);
        changed.push(name);
    }
    return changed;
}
