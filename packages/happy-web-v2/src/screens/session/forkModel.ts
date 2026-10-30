import type { Session } from '@/sync/storageTypes';
import type { SimpleTranslationKey } from '@/text';
import { getSessionForkSource, type ForkSource } from '@/utils/sessionFork';
import { stripHarnessBlocks } from './harness';

/**
 * B-851: when a session can be forked from the Web, and how a failure is
 * explained. Pure — the wiring lives in forkFlow.ts.
 *
 * - `unsupported`: not a Claude / Codex session (pi, gemini, …) — no entry.
 * - `noHistory`: the agent never ran a turn, so there is no conversation id.
 * - `offline`: the owning machine is offline; the fork runs on that machine.
 * - `running`: a turn is in progress; its transcript is still being written.
 */
export type ForkBlock = 'unsupported' | 'noHistory' | 'offline' | 'running';

export function isForkableFlavor(flavor: string | null | undefined): boolean {
    return (flavor ?? 'claude') === 'claude' || flavor === 'codex';
}

export function sessionForkBlock(
    session: Pick<Session, 'id' | 'metadata'> | null | undefined,
    state: { machineOnline: boolean; running: boolean },
): ForkBlock | { source: ForkSource } {
    if (!session || !isForkableFlavor(session.metadata?.flavor)) return 'unsupported';
    const source = getSessionForkSource(session as Session);
    if (!source) return 'noHistory';
    if (!state.machineOnline) return 'offline';
    if (state.running) return 'running';
    return { source };
}

/** Rewind point the machine reports for one user prompt (claude uuid / codex item id). */
export type ForkPoint = { id: string; text: string };

function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/i;
// Claude writes the summary of a /compact as a user entry just before the command itself.
const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/;
const TASK_ID = /<task-id>\s*([^<\s]+)\s*<\/task-id>/i;
// Envelopes the daemon writes in front of a delivered message. A wrapper may
// prepend the project / board header, so they are matched at any line start.
const ENVELOPES: readonly [RegExp, string][] = [
    [/^\[Very Happy team message ([^;\]\n]+)/m, 'team'],
    [/^\[Very Happy session message (\S+) from /m, 'peer'],
    [/^\[Very Happy automation "[^"\n]*" run ([^;\]\s]+)/m, 'automation'],
];

/**
 * Prompts nobody typed into this session: the Claude runtime's
 * `<task-notification>` (a background Bash / sub-agent finished) and other
 * harness-only blocks, the interrupt sentinel, and team / peer-session /
 * automation deliveries. They take a prompt slot on both sides but not in the
 * same order — a notification lands in the transcript the moment the task
 * ends, yet reaches the Web after the prompts queued meanwhile — so they are
 * paired by their own id, never by position or text.
 *
 * `undefined` = a typed prompt; `null` = injected without an id; else its id.
 */
export function injectedPromptKey(text: string): string | null | undefined {
    const trimmed = text.trim();
    if (INTERRUPTED.test(trimmed) || COMPACT_SUMMARY.test(trimmed)) return null;
    if (trimmed.startsWith('<') && stripHarnessBlocks(trimmed) === '') {
        const task = /<task-notification>/i.test(trimmed) ? trimmed.match(TASK_ID)?.[1] : undefined;
        return task ? `task:${task}` : null;
    }
    for (const [pattern, kind] of ENVELOPES) {
        const id = text.match(pattern)?.[1];
        if (id) return `${kind}:${id}`;
    }
    return undefined;
}

function contains(point: string, prompt: string): boolean {
    return normalize(point).includes(normalize(prompt));
}

/**
 * Prompts sent from the Web carry no claude uuid / codex item id, so the cut
 * point is found in the machine's own transcript (`*-list-rewind-points`).
 * An injected prompt (see injectedPromptKey) maps to the point with its id;
 * every other prompt is matched against the typed points only:
 *  1. same number on both sides AND every point contains its prompt → the
 *     point at the prompt's position (Codex folds its instructions into the
 *     first prompt, so only index 0 is exempt from the text check there);
 *  2. otherwise walk both lists in order and pair each prompt with the next
 *     point whose text contains it (a wrapper may add a prefix), so a
 *     repeated "continue" maps 1:1 and a short prompt never lands on an
 *     earlier, longer one.
 * A cut right after a compaction summary moves before it: forking from
 * 「/compact」 keeps the history it compacted, not its summary.
 * Anything else is `null`: never guess a cut that could drop the wrong turns.
 */
export function resolveForkPoint(
    prompts: readonly { id: string; text: string }[],
    messageId: string,
    points: readonly ForkPoint[],
    kind: 'claude' | 'codex' = 'claude',
): string | null {
    const target = prompts.find((prompt) => prompt.id === messageId);
    if (!target) return null;
    const targetKey = injectedPromptKey(target.text);
    if (targetKey !== undefined) {
        const same = targetKey === null ? [] : points.filter((point) => injectedPromptKey(point.text) === targetKey);
        return same.length === 1 ? same[0].id : null;
    }
    const typed = prompts.filter((prompt) => injectedPromptKey(prompt.text) === undefined);
    const candidates = points.filter((point) => injectedPromptKey(point.text) === undefined);
    const point = pairTyped(typed, typed.indexOf(target), candidates, kind);
    if (!point) return null;
    let at = points.indexOf(point);
    while (at > 0 && COMPACT_SUMMARY.test(points[at - 1].text.trim())) at--;
    return points[at].id;
}

function pairTyped(
    typed: readonly { id: string; text: string }[],
    index: number,
    candidates: readonly ForkPoint[],
    kind: 'claude' | 'codex',
): ForkPoint | null {
    if (typed.length === candidates.length
        && typed.every((prompt, i) => (kind === 'codex' && i === 0) || contains(candidates[i].text, prompt.text))) {
        return candidates[index];
    }
    let cursor = 0;
    for (let i = 0; i <= index; i++) {
        if (!normalize(typed[i].text)) continue;
        const found = candidates.findIndex((candidate, j) => j >= cursor && contains(candidate.text, typed[i].text));
        if (found < 0) continue;
        if (i === index) return candidates[found];
        cursor = found + 1;
    }
    return null;
}

/**
 * Why a fork RPC failed, from what the machine / server said:
 * - the daemon's own `Method not found`, or an older CLI meeting a Codex whose
 *   forks refuse the deprecated rollback → the CLI is too old;
 * - the server's `RPC method not available` means no daemon registered the
 *   method: offline, or a daemon too old for it (todoFailure.ts). The machine
 *   flag lags a stopped daemon by the server's ~15 s grace, so while it still
 *   reads online the copy names both causes instead of guessing.
 */
export function forkFailureKind(message: string, machineOnline: boolean): 'offline' | 'outdated' | 'unreachable' | 'failed' {
    if (message === 'Method not found' || message.includes('paginated threads do not support thread/rollback')) return 'outdated';
    if (!machineOnline) return 'offline';
    if (message === 'RPC method not available') return 'unreachable';
    return 'failed';
}

export type ForkReason = ForkBlock | 'attachments' | 'pending' | 'outdated' | 'unreachable' | 'missingPoint' | 'failed';
const REASON_KEY = {
    unsupported: 'session.forkUnsupported',
    noHistory: 'session.forkErrorNoHistory',
    offline: 'session.forkErrorOffline',
    running: 'session.forkErrorRunning',
    attachments: 'session.forkErrorAttachments',
    pending: 'session.forkErrorPending',
    outdated: 'session.forkErrorOutdated',
    unreachable: 'session.forkErrorUnreachable',
    missingPoint: 'session.forkErrorMissingPoint',
    failed: 'session.forkErrorGeneric',
} as const satisfies Record<ForkReason, SimpleTranslationKey>;

/** One sentence the user can act on; a generic failure keeps the machine's own words after it. */
export function forkReasonText(t: (key: SimpleTranslationKey) => string, reason: ForkReason, detail?: string): string {
    const text = t(REASON_KEY[reason]);
    return reason === 'failed' && detail ? `${text} ${detail}` : text;
}
