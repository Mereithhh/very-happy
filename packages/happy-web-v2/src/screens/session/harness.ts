/**
 * Harness/system block stripping + local-slash-command parsing.
 *
 * Ported from v1 `components/parseLocalCommandMessage.ts` so that machine-facing
 * blocks the Claude Code runtime injects (<task-notification>, <system-reminder>,
 * captured local-command output) never leak into the chat transcript as raw
 * `<tag>…</tag>` text, and so `/foo` slash-command wrappers collapse cleanly.
 */

import { stripAttachedFiles } from './attachedFiles';

export type LocalCommandMessage =
    | { kind: 'caveat' }
    | { kind: 'command-run'; commandName: string; args?: string }
    | { kind: 'text'; text: string };

const HARNESS_BLOCK_RE =
    /<(task-notification|system-reminder|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/gi;

export function stripHarnessBlocks(text: string): string {
    if (!text || text.indexOf('<') === -1) return text;
    // `<attached_files>` is the CLI's own prompt augmentation, not a Claude
    // harness block, but it is machine-facing in exactly the same way and must
    // never be readable in a chat bubble (B-355; the manifest is rendered as an
    // attachment strip instead — see attachedFiles.ts).
    return stripAttachedFiles(text.replace(HARNESS_BLOCK_RE, ''))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<]+?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/;
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*?<\/command-message>/g;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;
const COMMAND_ARGS_TAG_RE = /<command-args>[\s\S]*?<\/command-args>/g;

export function parseLocalCommandMessage(text: string): LocalCommandMessage {
    if (CAVEAT_RE.test(text)) {
        return { kind: 'caveat' };
    }

    const nameMatch = text.match(COMMAND_NAME_RE);
    if (nameMatch) {
        const argsMatch = text.match(COMMAND_ARGS_RE);
        const args = argsMatch?.[1].trim();
        const stripped = text
            .replace(COMMAND_MESSAGE_RE, '')
            .replace(COMMAND_NAME_TAG_RE, '')
            .replace(COMMAND_ARGS_TAG_RE, '')
            .trim();
        if (stripped.length === 0) {
            return {
                kind: 'command-run',
                commandName: nameMatch[1],
                args: args && args.length > 0 ? args : undefined,
            };
        }
        return { kind: 'text', text: stripped };
    }

    return { kind: 'text', text };
}

const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w:-]*(?:\s[\s\S]*)?$/;

/**
 * True when this user-text message is the user's OWN echoed slash-command input
 * that the SDK will re-emit as a wrapper. Gated on hasLocalId so we only hide a
 * message the user actually sent from this client.
 */
export function isUserSlashCommandEcho(text: string, hasLocalId: boolean): boolean {
    if (!hasLocalId) return false;
    const trimmed = text.trim();
    if (!SLASH_COMMAND_RE.test(trimmed)) return false;
    return parseLocalCommandMessage(trimmed).kind === 'text';
}

// ── <task-notification> presentation (B-260) ────────────────────────────────
// The Claude Code runtime injects background-task completion notices as USER
// messages. They are real turn boundaries (the SDK starts a new assistant
// turn from them), so they must stay user messages — but rendering them as an
// empty stripped bubble (or reading the raw XML aloud in the voice assistant)
// hides the one thing the user cares about: which sub-agent/background task
// finished and how. Field presence measured on 797 real notifications:
// <summary> 98%, <status> 92% — every field is optional, degrade gracefully.

export type TaskNotification = {
    summary: string | null;
    status: 'completed' | 'failed' | 'stopped' | null;
};

/**
 * Parses a user message that IS a task notification (nothing but harness
 * blocks around it). Returns null for ordinary user text, including text that
 * merely contains a notification block alongside real content.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
    if (!text || !/<task-notification>/i.test(text)) return null;
    if (stripHarnessBlocks(text).length > 0) return null;
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1].trim() || null;
    const rawStatus = text.match(/<status>\s*([a-z]+)\s*<\/status>/i)?.[1].toLowerCase() ?? null;
    const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
        ? rawStatus
        : null;
    return { summary, status };
}
