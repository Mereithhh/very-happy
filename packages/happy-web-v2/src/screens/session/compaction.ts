/**
 * `/compact` in the transcript (B-540).
 *
 * The CLI marks a manual compaction with two service events —
 * `Compaction started` / `Compaction completed` (or `Compaction failed: …`) —
 * and the SDK then replays the user's own command as a
 * `<command-name>/compact</command-name>` user message, followed by a
 * `<local-command-stdout>Compacted</local-command-stdout>` one. Rendered as-is
 * that was a 「耗时」 activity holding two English mono lines plus a second
 * `/compact` bubble at the end. Claude Code, Codex and Cursor all show a
 * compaction as ONE boundary line in the conversation, so that is what the
 * turn becomes here.
 */
import type { Message } from '@/sync/typesMessage';
import { parseLocalCommandMessage } from './harness';

export type CompactionEvent = { kind: 'started' } | { kind: 'completed' } | { kind: 'failed'; error: string };

const FAILED_PREFIX = 'Compaction failed:';

export function compactionEventOf(message: Message): CompactionEvent | null {
    if (message.kind !== 'agent-event' || message.event.type !== 'message') return null;
    const text = message.event.message.trim();
    if (text === 'Compaction started') return { kind: 'started' };
    if (text === 'Compaction completed') return { kind: 'completed' };
    if (text.startsWith(FAILED_PREFIX)) return { kind: 'failed', error: text.slice(FAILED_PREFIX.length).trim() };
    return null;
}

export type CompactionState = 'running' | 'done' | 'failed' | 'interrupted';

export interface CompactionSummary {
    state: CompactionState;
    /** createdAt of `Compaction started` (the live timer's anchor). */
    startedAt?: number;
    durationSeconds?: number;
    error?: string;
}

/**
 * A turn whose every visible message is a compaction event collapses to one
 * summary; anything else in the turn (a stop, an error, real agent output)
 * keeps the ordinary rendering so nothing is hidden.
 */
export function summarizeCompactionTurn(renderable: readonly Message[], live: boolean): CompactionSummary | null {
    if (renderable.length === 0) return null;
    const events: Array<{ message: Message; event: CompactionEvent }> = [];
    for (const message of renderable) {
        const event = compactionEventOf(message);
        if (!event) return null;
        events.push({ message, event });
    }
    const started = events.find(({ event }) => event.kind === 'started')?.message;
    const ended = [...events].reverse().find(({ event }) => event.kind !== 'started');
    const startedAt = started?.createdAt;
    const durationSeconds = startedAt !== undefined && ended
        ? Math.max(0, Math.round((ended.message.createdAt - startedAt) / 1000))
        : undefined;
    if (ended?.event.kind === 'failed') return { state: 'failed', startedAt, durationSeconds, error: ended.event.error };
    if (ended?.event.kind === 'completed') return { state: 'done', startedAt, durationSeconds };
    return { state: live ? 'running' : 'interrupted', startedAt };
}

function slashCommandText(message: Message): string | null {
    if (message.kind !== 'user-text') return null;
    const text = (message.displayText ?? message.text).trim();
    return text.startsWith('/') && parseLocalCommandMessage(text).kind === 'text' ? text.replace(/\s+/g, ' ') : null;
}

/** Only the local-command stdout / caveat wrapper — `UserText` renders nothing. */
const COMMAND_OUTPUT_ONLY = /^\s*(?:<(local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>\s*)+$/;

/**
 * Drop the SDK's replay of a slash command the user already sent (and the
 * empty stdout/caveat wrappers that come with it). Must happen at the
 * `chronological` layer, like `dropDuplicateAttachmentEchoes`: every
 * user-text cuts a turn, rendered or not, so leaving them in split the
 * compaction turn and moved the liveness window.
 *
 * A replay is dropped only when the latest user prompt before it is that
 * same command typed by the user; a command run from the terminal (no typed
 * twin) keeps its `/command` chip.
 */
export function dropSlashCommandEchoes(messages: readonly Message[]): Message[] {
    let found = false;
    let lastTypedCommand: string | null = null;
    let afterEcho = false;
    const kept: Message[] = [];
    for (const message of messages) {
        if (message.kind === 'user-text') {
            const raw = message.displayText ?? message.text;
            const parsed = parseLocalCommandMessage(raw);
            if (parsed.kind === 'command-run') {
                const echoed = `/${parsed.commandName}${parsed.args ? ` ${parsed.args}` : ''}`.replace(/\s+/g, ' ');
                if (lastTypedCommand === echoed) {
                    found = true;
                    lastTypedCommand = null;
                    afterEcho = true;
                    continue;
                }
            } else if (afterEcho && (parsed.kind === 'caveat' || COMMAND_OUTPUT_ONLY.test(raw))) {
                found = true;
                continue;
            }
            lastTypedCommand = slashCommandText(message);
            afterEcho = false;
        }
        kept.push(message);
    }
    return found ? kept : (messages as Message[]);
}
