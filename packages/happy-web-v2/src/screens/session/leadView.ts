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
 * `keep` is the extension point for other rows that must stay visible inside
 * a folded run (the lead's 「已上板」 pointer).
 */
import type { TeamMessage, TeamState } from '@slopus/happy-wire';
import type { Message, UserTextMessage } from '@/sync/typesMessage';
import { extractUserAttachments, opensTurn, renderableAgentText, type ChatRow } from './chatTurns';
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
};
/** `via`: on the first lead text of a member / system turn — who it answers. */
export type LeadViewEntry = { type: 'row'; row: ChatRow; via?: TurnOrigin } | LeadFold;

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
    for (const row of rows) {
        const opener = rowOpener(row, openers);
        let info: TurnOrigin | null = null;
        if (opener) {
            info = origin(opener);
            turn = { origin: info, countedIn: null, captioned: false };
        }
        if (!turn || turn.origin.source === 'owner' || keep(row)) {
            close();
            out.push({ type: 'row', row });
            continue;
        }
        if (isLeadReply(row, openers)) {
            close();
            // The owner's own answer row is not the lead's reply: the line goes on the lead's text.
            const lead = row.type === 'activity' || (row.type === 'message' && row.message.kind === 'agent-text');
            out.push({ type: 'row', row, ...(lead && !turn.captioned ? { via: turn.origin } : {}) });
            if (lead) turn.captioned = true;
            continue;
        }
        const run: LeadFold = fold ?? { type: 'fold', key: `fold-${row.key}`, rows: [], members: 0, system: 0, leadTurns: 0, senders: [] };
        fold = run;
        run.rows.push(row);
        if (info) {
            if (info.source === 'member') run.members++;
            else run.system++;
            if (info.sender && !run.senders.includes(info.sender)) run.senders.push(info.sender);
        }
        // A notification-triggered activity row is both the opener and the lead's work.
        if ((!opener || row.type === 'activity') && turn.countedIn !== run) {
            turn.countedIn = run;
            run.leadTurns++;
        }
    }
    close();
    return out;
}

/** Keys of what is on screen — the follow / unseen-count logic reads these, so noise folding into a run does not count as new. */
export function leadViewKeys(entries: readonly LeadViewEntry[], expanded: ReadonlySet<string>): string[] {
    const keys: string[] = [];
    for (const entry of entries) {
        if (entry.type === 'row') keys.push(entry.row.key);
        else {
            keys.push(entry.key);
            if (expanded.has(entry.key)) for (const row of entry.rows) keys.push(row.key);
        }
    }
    return keys;
}
