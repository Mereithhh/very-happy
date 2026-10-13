/**
 * B-585 repository worktree config (`.veryhappy/worktree.json`) — pure parsing
 * and path-pattern validation. See specs/2026-10-worktree-sessions-and-setup.md §1.
 *
 * Everything here is input from an UNTRUSTED repository: a pattern that is not
 * provably repo-relative is rejected, never "normalised" into something usable.
 */
import { createHash } from 'node:crypto';

export const CONFIG_RELATIVE_PATH = '.veryhappy/worktree.json';
export const CONFIG_MAX_BYTES = 64 * 1024;
export const SCRIPT_MAX_BYTES = 32 * 1024;
export const MAX_COPY_PATTERNS = 64;
export const MAX_LINK_ENTRIES = 16;
export const DEFAULT_SETUP_TIMEOUT_MINUTES = 10;
/** No config file + a web-created worktree → copy root-level `.env*` only. */
export const DEFAULT_WEB_COPY = ['.env*'] as const;

export type WorktreeOrigin = 'web' | 'teams' | 'automation';
export type SetupRunner = 'posix-sh' | 'shebang' | 'cmd';

export interface WorktreeConfig {
    copy: string[];
    link: string[];
    setup: string | null;
    setupWindows: string | null;
    setupTimeoutMinutes: number;
}

export type ConfigSource = 'file' | 'default' | 'none' | 'invalid';

export interface ResolvedConfig {
    source: ConfigSource;
    config: WorktreeConfig;
    /** Why the file was ignored (source === 'invalid'), or per-entry problems. */
    errors: string[];
}

export const EMPTY_CONFIG: WorktreeConfig = { copy: [], link: [], setup: null, setupWindows: null, setupTimeoutMinutes: DEFAULT_SETUP_TIMEOUT_MINUTES };

/**
 * A pattern is safe when it is relative, uses `/` separators, and has no empty,
 * `.` or `..` segment. Backslashes are rejected outright (on Windows they are a
 * separator, so `..\\x` would otherwise slip past a `/`-only check).
 */
export function isSafeRelativePattern(pattern: string): boolean {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512) return false;
    if (pattern.includes('\0') || pattern.includes('\\')) return false;
    if (pattern.startsWith('/') || /^[a-zA-Z]:/.test(pattern) || pattern.startsWith('~')) return false;
    const segments = pattern.split('/');
    return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** `*` / `?` inside one path segment; everything else literal. */
export function globSegmentToRegExp(segment: string): RegExp {
    let source = '^';
    for (const ch of segment) {
        if (ch === '*') source += '[^/]*';
        else if (ch === '?') source += '[^/]';
        else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${source}$`);
}

export function hasGlob(segment: string): boolean {
    return segment.includes('*') || segment.includes('?');
}

function clampTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETUP_TIMEOUT_MINUTES;
    return Math.min(60, Math.max(1, Math.round(value)));
}

function readScript(value: unknown, field: string, errors: string[]): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') { errors.push(`${field} must be a string`); return null; }
    if (Buffer.byteLength(value, 'utf8') > SCRIPT_MAX_BYTES) { errors.push(`${field} exceeds ${SCRIPT_MAX_BYTES} bytes`); return null; }
    return value.trim() ? value : null;
}

function readPatterns(value: unknown, field: string, max: number, errors: string[]): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return []; }
    const out: string[] = [];
    for (const entry of value.slice(0, max)) {
        if (typeof entry === 'string' && isSafeRelativePattern(entry)) out.push(entry);
        else errors.push(`${field}: rejected ${JSON.stringify(entry).slice(0, 80)}`);
    }
    if (value.length > max) errors.push(`${field}: only the first ${max} entries are used`);
    return out;
}

/**
 * Parse the config file text. `text === null` means no file. Invalid JSON or a
 * non-object root ignores the WHOLE file (never half-applied).
 */
export function parseWorktreeConfig(text: string | null, origin: WorktreeOrigin): ResolvedConfig {
    if (text === null) {
        return origin === 'web'
            ? { source: 'default', config: { ...EMPTY_CONFIG, copy: [...DEFAULT_WEB_COPY] }, errors: [] }
            : { source: 'none', config: { ...EMPTY_CONFIG }, errors: [] };
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { return { source: 'invalid', config: { ...EMPTY_CONFIG }, errors: [`${CONFIG_RELATIVE_PATH} is not valid JSON`] }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { source: 'invalid', config: { ...EMPTY_CONFIG }, errors: [`${CONFIG_RELATIVE_PATH} must be a JSON object`] };
    }
    const obj = raw as Record<string, unknown>;
    const errors: string[] = [];
    const config: WorktreeConfig = {
        copy: readPatterns(obj.copy, 'copy', MAX_COPY_PATTERNS, errors),
        link: readPatterns(obj.link, 'link', MAX_LINK_ENTRIES, errors).filter((entry) => {
            if (hasGlob(entry)) { errors.push(`link: globs are not allowed (${entry})`); return false; }
            return true;
        }),
        setup: readScript(obj.setup, 'setup', errors),
        setupWindows: readScript(obj.setupWindows, 'setupWindows', errors),
        setupTimeoutMinutes: clampTimeout(obj.setupTimeoutMinutes),
    };
    return { source: 'file', config, errors };
}

export function isShebangScript(script: string): boolean {
    return script.trimStart().startsWith('#!');
}

/**
 * Which script text and runner this platform would execute. Windows: a `#!`
 * script cannot run under cmd — `unsupported` (Orca refuses the same way rather
 * than half-running a POSIX script).
 */
export function selectSetupScript(config: WorktreeConfig, platform: NodeJS.Platform):
    | { kind: 'none' }
    | { kind: 'unsupported'; script: string; message: string }
    | { kind: 'script'; script: string; runner: SetupRunner } {
    if (platform === 'win32') {
        const script = config.setupWindows ?? config.setup;
        if (!script) return { kind: 'none' };
        if (isShebangScript(script)) {
            return { kind: 'unsupported', script, message: 'A "#!" setup script needs a POSIX shell; native Windows runs setup through cmd.exe. Add "setupWindows" with cmd syntax.' };
        }
        return { kind: 'script', script, runner: 'cmd' };
    }
    const script = config.setup;
    if (!script) return { kind: 'none' };
    return { kind: 'script', script, runner: isShebangScript(script) ? 'shebang' : 'posix-sh' };
}

/** The runner is part of the trusted code: the same text under another interpreter is another program. */
export function setupScriptHash(runner: SetupRunner, script: string): string {
    return createHash('sha256').update(`${runner}\0${script}`, 'utf8').digest('hex');
}

/** Human description of how the script is launched (shown in the approval dialog). */
export function describeRunner(runner: SetupRunner): string {
    if (runner === 'cmd') return 'cmd.exe /d /c setup.cmd';
    if (runner === 'shebang') return './setup (its own #! interpreter)';
    return '/bin/sh -e setup.sh';
}
