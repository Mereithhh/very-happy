import type { Session } from '@/sync/storageTypes';
import type { SimpleTranslationKey } from '@/text';
import { getSessionForkSource, type ForkSource } from '@/utils/sessionFork';

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

/**
 * Prompts sent from the Web carry no claude uuid / codex item id, so the cut
 * point is found in the machine's own transcript (`*-list-rewind-points`):
 *  1. both sides hold the same number of prompts → the point at the prompt's
 *     position (Codex folds its instructions into the first prompt, so that
 *     text never contains what the user typed);
 *  2. otherwise walk both lists in order and pair each prompt with the next
 *     point whose text contains it (a wrapper may add a prefix), so a
 *     repeated "continue" maps 1:1 and a short prompt never lands on an
 *     earlier, longer one.
 * Anything else is `null`: never guess a cut that could drop the wrong turns.
 */
export function resolveForkPoint(
    prompts: readonly { id: string; text: string }[],
    messageId: string,
    points: readonly ForkPoint[],
): string | null {
    const index = prompts.findIndex((prompt) => prompt.id === messageId);
    if (index < 0) return null;
    if (prompts.length === points.length) return points[index].id;
    const texts = points.map((point) => normalize(point.text));
    let cursor = 0;
    for (let i = 0; i <= index; i++) {
        const text = normalize(prompts[i].text);
        if (!text) continue;
        const found = texts.findIndex((candidate, j) => j >= cursor && candidate.includes(text));
        if (found < 0) continue;
        if (i === index) return points[found].id;
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
