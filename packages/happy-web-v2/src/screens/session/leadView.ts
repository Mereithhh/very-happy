/**
 * B-766 B-1 — 「只看我和负责人」: the lead session's transcript reduced to
 * what is between the owner and the lead.
 *
 * Every turn is classified by the message that opened it, from transport
 * fields only — never from prose:
 *   - `meta.sentFrom === 'team'` → the team message record (`TeamMessage.source`
 *     / `senderBotId`, matched by the envelope's message id); when the record
 *     is not in the team snapshot, the envelope's `from` (written by the
 *     daemon from the same fields, `teams/worker.ts`);
 *   - `<task-notification>` (a background task finishing), `automation` and
 *     `assistant` → system;  `session-peer` → another agent (member);
 *   - anything else a person typed (web / ios / android / mac / cli / shared)
 *     → owner.
 * Owner turns stay as they are. In member / system turns only the inbound
 * message and the lead's process (tools, progress lines, file rollup) fold;
 * consecutive ones join one summary row. B-809: the lead's own text never
 * folds, whoever triggered it — the lead talks to members through
 * `team_message` (a tool call), so its text is written to the owner (「已经
 * 上线」, the 「等你决定」 options). The first such row of a turn carries the
 * turn's origin (`via`) for a one-line 「回复 成员 A 的提交」 above it.
 * B-833: that is EVERY lead text of the turn, not only the last one — a
 * member / system turn's activity row is cut at each of the lead's texts
 * (`splitLeadText`): mid-turn text (「同意最小修法」 before a team_message) and
 * the live turn's text so far stay on screen in their place; the tools,
 * progress lines and thinking between them fold. The newest batch of member
 * messages shows their text as a preview under its fold row (`previewFolds`).
 * `keep` is the extension point for other rows that must stay visible inside
 * a folded run (the lead's 「已上板」 pointer).
 */
import type { TeamMessage, TeamState } from '@slopus/happy-wire';
import type { Message, UserTextMessage } from '@/sync/typesMessage';
import { activityDurationSeconds, extractUserAttachments, opensTurn, renderableAgentText, type ChatRow } from './chatTurns';
import { parseTaskNotification } from './harness';
import { stripTeamEnvelope } from './teamMessage';

export type LeadViewMode = 'all' | 'owner';
export type TurnSource = 'owner' | 'member' | 'system';
/** `submit`: the server's submit notice (`Task <id> submitted:`, happy-server teams reducer). */
export type TurnOrigin = { source: TurnSource; sender?: string; submit?: true };

/** `sentFrom` values written by a machine on nobody's behalf. */
const SYSTEM_SENT_FROM = new Set(['automation', 'assistant']);
/** The body the teams reducer writes for `team_submit` (machine-written, fixed shape). */
const SUBMIT_NOTICE = /^Task \S+ submitted:\n/;

/** A team snapshot is immutable (replaced on every poll): index its messages once. */
const recordIndex = new WeakMap<TeamState, Map<string, TeamMessage>>();
function teamRecord(team: TeamState | undefined, id: string): TeamMessage | undefined {
    if (!team) return undefined;
    let index = recordIndex.get(team);
    if (!index) recordIndex.set(team, (index = new Map(team.messages.map((m) => [m.id, m]))));
    return index.get(id);
}

export function turnOrigin(message: Pick<UserTextMessage, 'text' | 'meta' | 'displayText'>, team: TeamState | undefined): TurnOrigin {
    if (parseTaskNotification(message.displayText ?? message.text)) return { source: 'system' };
    const from = message.meta?.sentFrom;
    if (from === 'team') {
        const envelope = stripTeamEnvelope(message.text);
        // No envelope = the member's initial assignment; for the lead that is the owner's own goal.
        if (!envelope.messageId) return { source: 'owner' };
        const record = teamRecord(team, envelope.messageId);
        if (record) {
            if (record.source === 'system') return { source: 'system' };
            if (record.senderBotId) {
                const bot = team?.bots.find((b) => b.id === record.senderBotId);
                return { source: 'member', ...(bot?.name || envelope.sender ? { sender: bot?.name || envelope.sender } : {}), ...(SUBMIT_NOTICE.test(record.body) ? { submit: true as const } : {}) };
            }
            return { source: 'owner' };
        }
        if (envelope.sender === 'System') return { source: 'system' };
        if (envelope.sender === 'Owner') return { source: 'owner' };
        return { source: 'member', ...(envelope.sender ? { sender: envelope.sender } : {}), ...(SUBMIT_NOTICE.test(envelope.body) ? { submit: true as const } : {}) };
    }
    if (from === 'session-peer') return { source: 'member' };
    if (from && SYSTEM_SENT_FROM.has(from)) return { source: 'system' };
    return { source: 'owner' };
}

/** Ids of the user-text messages that open a turn — the same walk as `buildChatRows`. */
export function turnOpenerIds(transcript: readonly Message[]): Set<string> {
    const chronological = extractUserAttachments([...transcript]).messages;
    const ids = new Set<string>();
    let turnStart = 0;
    for (let i = 0; i < chronological.length; i++) {
        if (!opensTurn(chronological, i, turnStart)) continue;
        ids.add(chronological[i].id);
        turnStart = i + 1;
    }
    return ids;
}

/**
 * Owner turn → the lead's answer to it (phase 1, derived here: the turn has
 * lead text). The last text wins: that is the visible answer row of a
 * finished turn (`buildChatRows` folds the earlier ones into its activity).
 */
export function ownerAnswers(transcript: readonly Message[], origin: (m: UserTextMessage) => TurnOrigin): Map<string, string> {
    const chronological = extractUserAttachments([...transcript]).messages;
    const answers = new Map<string, string>();
    let owner: string | null = null;
    let turnStart = 0;
    for (let i = 0; i < chronological.length; i++) {
        const message = chronological[i];
        if (opensTurn(chronological, i, turnStart)) {
            turnStart = i + 1;
            owner = message.kind === 'user-text' && origin(message).source === 'owner' ? message.id : null;
            continue;
        }
        if (owner && message.kind === 'agent-text' && !message.isThinking && renderableAgentText(message)) answers.set(owner, message.id);
    }
    return answers;
}

export type LeadFold = {
    type: 'fold';
    /** The first folded row's key: stable while more noise lands in the same run. */
    key: string;
    rows: ChatRow[];
    members: number;
    system: number;
    /** Turns whose lead work (tools, progress, rollup) is in this run. */
    leadTurns: number;
    /** Distinct member names, in order of appearance. */
    senders: string[];
    /** B-833: the member messages that opened turns in this run — the newest batch's preview. */
    preview: ChatRow[];
};
/**
 * `via`: on the first lead text of a member / system turn — who it answers.
 * `owner`: the row belongs to an owner turn (or precedes every turn) — the
 * newest-batch preview stops there.
 */
export type LeadViewEntry = { type: 'row'; row: ChatRow; via?: TurnOrigin; owner?: true } | LeadFold;

function rowOpener(row: ChatRow, openers: ReadonlySet<string>): UserTextMessage | null {
    if (row.type === 'message' && row.message.kind === 'user-text' && openers.has(row.message.id)) return row.message;
    if (row.type === 'activity' && row.trigger?.kind === 'user-text' && openers.has(row.trigger.id)) return row.trigger;
    return null;
}

/**
 * What the lead says to the owner inside a member / system turn: its text
 * rows (not thinking), the owner's own AskUserQuestion answer, and a held
 * turn (`keepTurnsOpen`, B-615) whose answer is still inside its activity row.
 */
function isLeadReply(row: ChatRow, openers: ReadonlySet<string>): boolean {
    if (row.type === 'activity') return row.answer !== undefined;
    if (row.type !== 'message') return false;
    const m = row.message;
    if (m.kind === 'agent-text') return !m.isThinking && renderableAgentText(m);
    return m.kind === 'user-text' && row.key.endsWith(':answer') && !openers.has(m.id);
}

const isLeadText = (m: Message): boolean => m.kind === 'agent-text' && !m.isThinking && renderableAgentText(m);

/**
 * B-833: a member / system turn's activity row, cut at the lead's own text.
 * The texts become message rows keyed by message id — the key the turn's
 * final text keeps as its answer row once the turn ends, so nothing remounts
 * when it does. The work between them stays in activity rows that fold; a
 * segment's key comes from the text before it, so a live row only appends.
 * A task notification heading the row becomes its own line (keyed by its id).
 * A held answer (B-615) becomes its row too, with the props it is held with:
 * cut this way, a held turn and the released one are the same rows, so the
 * release changes nothing here (inside the activity row it was hidden — the
 * live segment it lands in was folded, and remounts closed). Empty segments
 * are dropped.
 */
export function splitLeadText(row: ChatRow): ChatRow[] {
    if (row.type !== 'activity') return [row];
    const held = row.answer;
    const out: ChatRow[] = [];
    if (row.trigger) out.push({ type: 'message', key: row.trigger.id, message: row.trigger, showMeta: false });
    let segment: Message[] = [];
    let segmentKey = row.key;
    let split = false;
    const flush = (last: boolean) => {
        if (segment.length === 0) return;
        out.push({
            type: 'activity',
            key: segmentKey,
            messages: segment,
            live: last && row.live,
            durationSeconds: last && !split ? row.durationSeconds : activityDurationSeconds(segment),
            ...(row.abortedAt !== undefined ? { abortedAt: row.abortedAt } : {}),
        });
    };
    row.messages.forEach((message, index) => {
        if (!isLeadText(message)) {
            segment.push(message);
            return;
        }
        flush(false);
        if (message.id === held?.id) {
            out.push({ type: 'message', key: message.id, message, showMeta: held.showMeta, ...(held.showActions ? {} : { showActions: false }), ...(held.optionsActive ? { optionsActive: true } : {}) });
        } else {
            // As in buildLeafRows: a text with work after it is a progress line, not an answer (no actions).
            const toolFollows = row.messages.slice(index + 1).some((m) => m.kind === 'tool-call');
            out.push({ type: 'message', key: message.id, message, showMeta: false, ...(toolFollows ? { showActions: false } : {}) });
        }
        segment = [];
        segmentKey = `${row.key}:after-${message.id}`;
        split = true;
    });
    flush(true);
    return out;
}

export function leadViewEntries(
    rows: readonly ChatRow[],
    openers: ReadonlySet<string>,
    origin: (m: UserTextMessage) => TurnOrigin,
    keep: (row: ChatRow) => boolean = () => false,
): LeadViewEntry[] {
    const out: LeadViewEntry[] = [];
    let fold: LeadFold | null = null;
    let turn: { origin: TurnOrigin; countedIn: LeadFold | null; captioned: boolean } | null = null;
    const close = () => {
        if (fold) out.push(fold);
        fold = null;
    };
    const place = (row: ChatRow, info: TurnOrigin | null) => {
        if (!turn || turn.origin.source === 'owner') {
            close();
            out.push({ type: 'row', row, owner: true });
            return;
        }
        if (keep(row)) {
            close();
            out.push({ type: 'row', row });
            return;
        }
        if (isLeadReply(row, openers)) {
            close();
            // The owner's own answer row is not the lead's reply: the line goes on the lead's text.
            const lead = row.type === 'activity' || (row.type === 'message' && row.message.kind === 'agent-text');
            out.push({ type: 'row', row, ...(lead && !turn.captioned ? { via: turn.origin } : {}) });
            if (lead) turn.captioned = true;
            return;
        }
        const run: LeadFold = fold ?? { type: 'fold', key: `fold-${row.key}`, rows: [], members: 0, system: 0, leadTurns: 0, senders: [], preview: [] };
        fold = run;
        run.rows.push(row);
        if (info) {
            if (info.source === 'member') {
                run.members++;
                run.preview.push(row);
            } else run.system++;
            if (info.sender && !run.senders.includes(info.sender)) run.senders.push(info.sender);
        }
        // A notification-triggered activity row is both the opener and the lead's work.
        if ((!info || row.type === 'activity') && turn.countedIn !== run) {
            turn.countedIn = run;
            run.leadTurns++;
        }
    };
    for (const row of rows) {
        const opener = rowOpener(row, openers);
        if (opener) turn = { origin: origin(opener), countedIn: null, captioned: false };
        if (!turn || turn.origin.source === 'owner') {
            place(row, null);
            continue;
        }
        // B-833: cut at the lead's text; the opener is the first piece (a notification heads its activity row).
        splitLeadText(row).forEach((piece, i) => place(piece, opener && i === 0 ? turn!.origin : null));
    }
    close();
    return out;
}

/** A fold of the lead's own work only (no inbound message): what it hides is noise, never news. */
const workOnly = (fold: LeadFold) => fold.members === 0 && fold.system === 0;

/**
 * B-833: the folds that show their member messages as a preview — the newest
 * batch (the last fold with an inbound message, nothing from the owner after
 * it), plus folds that showed one before (`shown`) while still nothing from
 * the owner came after them: a batch keeps its preview when a newer one
 * lands, so text being read never collapses under the reader. The owner's
 * next message (sent from the live end) retires them all.
 */
export function previewFolds(entries: readonly LeadViewEntry[], shown: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    let newest = true;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === 'row') {
            if (entry.owner) break;
            continue;
        }
        if (workOnly(entry)) continue;
        if ((newest || shown.has(entry.key)) && entry.preview.length > 0) out.add(entry.key);
        newest = false;
    }
    return out;
}

/**
 * Keys of what is on screen — the follow / unseen-count logic reads these, so
 * noise folding into a run does not count as new. B-833: neither does a
 * closed fold of the lead's own work (the tools after its text) — the text
 * above it is the news, and it is counted already.
 */
export function leadViewKeys(entries: readonly LeadViewEntry[], expanded: ReadonlySet<string>): string[] {
    const keys: string[] = [];
    for (const entry of entries) {
        if (entry.type === 'row') keys.push(entry.row.key);
        else if (expanded.has(entry.key)) {
            keys.push(entry.key);
            for (const row of entry.rows) keys.push(row.key);
        } else if (!workOnly(entry)) keys.push(entry.key);
    }
    return keys;
}
