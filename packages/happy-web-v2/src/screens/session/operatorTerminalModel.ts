/**
 * B-867 operator terminal — the pure bookkeeping of one operator-terminal
 * stream, kept apart from the pane so it can be unit-tested.
 *
 * The operator pane asks the daemon (through the broker) for the v1 "attach"
 * stream — no `streamMode: 'lines'` — so the bytes are the tmux client's own
 * screen output and xterm can render them as-is. What is left to decide is
 * ordering: an open/attach answer (snapshot or replay) and live frames race,
 * so frames at or below the last applied `seq` are dropped.
 */

export type OperatorOpenResult = {
    type?: string;
    terminalId: string;
    seq?: number;
} & (
    | { mode: 'snapshot'; data: string }
    | { mode: 'replay'; chunks: Array<{ seq: number; data: string }> }
);

export type OperatorTerminalListEntry = { terminalId: string; kind: 'opened' | 'attached'; openedAt: number };

export function isOpenResult(value: unknown): value is OperatorOpenResult {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.terminalId !== 'string' || !v.terminalId) return false;
    if (v.mode === 'snapshot') return typeof v.data === 'string';
    if (v.mode === 'replay') return Array.isArray(v.chunks);
    return false;
}

export function readTerminalList(value: unknown): OperatorTerminalListEntry[] {
    const list = (value && typeof value === 'object' ? (value as { terminals?: unknown }).terminals : null);
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const r = item as Record<string, unknown>;
        if (typeof r.terminalId !== 'string' || !r.terminalId) return [];
        const kind = r.kind === 'attached' ? 'attached' : 'opened';
        return [{ terminalId: r.terminalId, kind, openedAt: typeof r.openedAt === 'number' ? r.openedAt : 0 }];
    });
}

export interface OperatorStreamState {
    /** Highest output seq already written (−1 before the first open answer). */
    lastSeq: number;
}

export function initialStreamState(): OperatorStreamState {
    return { lastSeq: -1 };
}

/**
 * Apply an open/attach answer. Returns the writes to perform, in order, and
 * whether the screen must be reset first (snapshot).
 */
export function applyOpen(state: OperatorStreamState, result: OperatorOpenResult): { reset: boolean; writes: string[]; next: OperatorStreamState } {
    if (result.mode === 'snapshot') {
        return { reset: true, writes: result.data ? [result.data] : [], next: { lastSeq: typeof result.seq === 'number' ? result.seq : state.lastSeq } };
    }
    const chunks = [...result.chunks].filter((c) => c.seq > state.lastSeq).sort((a, b) => a.seq - b.seq);
    const last = chunks.length ? chunks[chunks.length - 1].seq : state.lastSeq;
    return { reset: false, writes: chunks.map((c) => c.data), next: { lastSeq: Math.max(last, typeof result.seq === 'number' ? result.seq : -1) } };
}

/** A live frame: write it unless it is already covered by what was applied. */
export function acceptLive(state: OperatorStreamState, seq: number | undefined): { write: boolean; next: OperatorStreamState } {
    if (typeof seq !== 'number') return { write: true, next: state };
    if (seq <= state.lastSeq) return { write: false, next: state };
    return { write: true, next: { lastSeq: seq } };
}

export function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function strToB64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
