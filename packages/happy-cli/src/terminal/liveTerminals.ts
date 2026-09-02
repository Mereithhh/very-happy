/**
 * Live-terminal snapshot (B-149) — pure state, no I/O.
 *
 * Why this exists: closures are detected by diffing the live tmux list against
 * an in-MEMORY `{title,cwd}` cache (webTerminal.trackClosures). That cache dies
 * with the process, so a daemon restart — and above all a machine REBOOT, which
 * takes the whole tmux server with it — produced no close records at all: the
 * terminals vanished from the live list AND never showed up in the archive.
 * 2026-08-23 in practice: 22 terminals disappeared without a trace and had to
 * be reconstructed by hand from a 52MB daemon log plus sessions.json.
 *
 * So the same cache is also written to disk. On the next start the snapshot is
 * reconciled ONCE against the first observed tmux list: every entry that is not
 * alive any more becomes a close record tagged `reason: 'daemon-gap'` — the
 * archive view then shows what was running before the gap, with the cwd and
 * (via pickMirrorForTerminal) the claude session id needed to resume it.
 *
 * Everything here is pure so the rules are unit-testable:
 *   - tolerant load (untrusted file: non-objects and malformed entries dropped);
 *   - TTL + hard cap, so a long-lived machine cannot grow the file forever;
 *   - a cheap change check, so the common tick (nothing changed) writes nothing;
 *   - terminal → mirror/claude-session resolution that only ever accepts an
 *     EXACT terminalId match (never cwd+time heuristics: with several terminals
 *     in one directory those mismatch, which would resume the wrong chat).
 */

/** What is remembered per live terminal — the same shape trackClosures caches,
 *  plus when it was last observed alive (the close record uses it as closedAt,
 *  so the archive shows "last alive", not "when the daemon happened to boot"). */
export interface LiveTerminalInfo {
    title?: string;
    cwd?: string;
    /** B-265: cross-device tags (@vh_tags) and the manual-rename flag
     *  (@vh_title_manual) at the time of observation, so a restore can put
     *  them back. Optional: old snapshots / daemons never wrote them. */
    tags?: string[];
    manual?: boolean;
    /** B-273: attached user tmux session (name), see webTerminal `@vh_attach`. */
    attachTmux?: string;
    /** B-287: the pane's real geometry when last observed, so a cold restore
     *  recreates the session at that size instead of a hardcoded one. */
    cols?: number;
    rows?: number;
    seenAt: number;
}

/** Tolerant read of a persisted / wire-delivered pane geometry. */
export function sanitizeGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 10_000;
    return ok(cols) && ok(rows) ? { cols, rows } : undefined;
}

/** Tolerant read of a persisted tags list (strings only, trimmed, capped). */
export function sanitizeTagList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    for (const tag of value) {
        if (typeof tag !== 'string') continue;
        const clean = tag.trim();
        if (clean && !out.includes(clean)) out.push(clean);
        if (out.length >= 64) break;
    }
    return out;
}

/** Entries older than this are dropped on load — a terminal last seen alive two
 *  weeks ago is not something anyone resumes, and it matches the retention of
 *  the persisted sessions the resume id comes from (persistence.ts). */
export const LIVE_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Hard cap (newest-first by seenAt) — bounds the file on a machine that opens
 *  a lot of terminals. Well above the observed real working set (~22). */
export const LIVE_SNAPSHOT_MAX = 100;

/** Tolerant load of the persisted snapshot: `{id: {title?,cwd?,seenAt}}`. */
export function sanitizeLiveSnapshot(
    raw: unknown,
    now: number,
    ttlMs: number = LIVE_SNAPSHOT_TTL_MS,
    max: number = LIVE_SNAPSHOT_MAX,
): Map<string, LiveTerminalInfo> {
    const out = new Map<string, LiveTerminalInfo>();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const rows: Array<[string, LiveTerminalInfo]> = [];
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!id || !value || typeof value !== 'object') continue;
        const { title, cwd, seenAt, tags, manual, attachTmux, cols: rawCols, rows: rawRows } = value as Record<string, unknown>;
        if (typeof seenAt !== 'number' || !Number.isFinite(seenAt)) continue;
        if (now - seenAt >= ttlMs) continue;
        const tagList = sanitizeTagList(tags);
        rows.push([id, {
            title: typeof title === 'string' && title.trim() ? title : undefined,
            cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
            ...(tagList !== undefined ? { tags: tagList } : {}),
            ...(manual === true ? { manual: true } : {}),
            ...(typeof attachTmux === 'string' && attachTmux ? { attachTmux } : {}),
            ...(sanitizeGeometry(rawCols, rawRows) ?? {}),
            seenAt,
        }]);
    }
    rows.sort((a, b) => b[1].seenAt - a[1].seenAt);
    for (const [id, info] of rows.slice(0, max)) out.set(id, info);
    return out;
}

/** Serializable form (plain object) of a snapshot map, newest-first capped. */
export function serializeLiveSnapshot(
    map: ReadonlyMap<string, LiveTerminalInfo>,
    max: number = LIVE_SNAPSHOT_MAX,
): Record<string, LiveTerminalInfo> {
    const rows = [...map.entries()].sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, max);
    const out: Record<string, LiveTerminalInfo> = {};
    for (const [id, info] of rows) out[id] = info;
    return out;
}

/** Did anything worth persisting change? Ignores seenAt drift on its own: the
 *  file exists to survive a restart, not to be an activity log — rewriting it
 *  on every 5s tick would be pure disk churn. */
export function liveSnapshotChanged(
    prev: ReadonlyMap<string, LiveTerminalInfo>,
    next: ReadonlyMap<string, LiveTerminalInfo>,
): boolean {
    if (prev.size !== next.size) return true;
    for (const [id, info] of next) {
        const before = prev.get(id);
        if (!before) return true;
        if (before.title !== info.title || before.cwd !== info.cwd) return true;
        if (!!before.manual !== !!info.manual) return true;
        if ((before.attachTmux ?? '') !== (info.attachTmux ?? '')) return true;
        if ((before.tags ?? []).join('\u0000') !== (info.tags ?? []).join('\u0000')) return true;
        if (before.cols !== info.cols || before.rows !== info.rows) return true;
    }
    return false;
}

/** Claude session ids are uuids; anything else never reaches a command line.
 *  The resume path builds `claude --resume <id>`, so the id is validated at the
 *  source instead of trusting a persisted (or wire-delivered) string. */
const CLAUDE_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(value: unknown): value is string {
    return typeof value === 'string' && CLAUDE_SESSION_ID_RE.test(value);
}

/** The subset of a persisted session this module needs (structural, so the
 *  caller can pass persistence.PersistedSession straight in). */
export interface MirrorLookupSession {
    savedAt?: number;
    metadata?: {
        flavor?: string;
        terminalId?: string;
        claudeSessionId?: string;
    } | null;
}

export interface MirrorLookupResult {
    /** Happy mirror session id (the shadow session of the claude that ran in
     *  the terminal) — gives the archive row its structured-history link. */
    sessionId: string;
    /** Underlying claude conversation, when known — what `--resume` takes. */
    claudeSessionId?: string;
}

/**
 * Find the mirror session of one terminal among persisted sessions: newest
 * `savedAt` wins, ONLY exact `metadata.terminalId` matches count, and a
 * claudeSessionId is reported only when it is a well-formed uuid.
 */
export function pickMirrorForTerminal(
    sessions: Record<string, MirrorLookupSession>,
    terminalId: string,
): MirrorLookupResult | null {
    if (!terminalId) return null;
    let best: { id: string; savedAt: number; claude?: string } | null = null;
    for (const [id, session] of Object.entries(sessions || {})) {
        const meta = session?.metadata;
        if (!meta || meta.terminalId !== terminalId) continue;
        const savedAt = typeof session.savedAt === 'number' ? session.savedAt : 0;
        if (best && savedAt <= best.savedAt) continue;
        best = {
            id,
            savedAt,
            claude: isClaudeSessionId(meta.claudeSessionId) ? meta.claudeSessionId : undefined,
        };
    }
    return best ? { sessionId: best.id, claudeSessionId: best.claude } : null;
}
