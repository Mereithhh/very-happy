/**
 * B-924d (QA-T on B-924c P1-2 / P1-3): who sent a chat message, readable from its plaintext localId and
 * `meta.sentFrom` — shared by the CLI (main agent turn origin) and the Web (which localId a click sends).
 *
 * - `option-<nonce>`: the owner clicked a suggestion chip (`<options>`) in an agent reply. The chip's text was
 *   written by the agent — possibly copied from an injected message — so the click is not the owner's words
 *   (the CLI treats it like a Briefing-board choice: `board_choice`, unlocks nothing).
 * - `retry-<nonce>`: 「重试」 re-sent a message the owner did not type (a send, an automation, a peer …), so the
 *   retry is not the owner's either. A retry of the owner's own message keeps an ordinary localId.
 */
import { ATTENTION_BOARD_LOCAL_ID_PREFIX } from './attention';

/**
 * B-924e: every `meta.sentFrom` a Very Happy client's composer writes (the Web's and the app's `resolveSentFrom`
 * are typed `ClientSentFrom`, so a new value does not compile until it is listed here). `mac` is the app on
 * Mac Catalyst / "Designed for iPad" — the owner typing, like `ios`.
 */
export const CLIENT_SENT_FROM = ['web', 'android', 'ios', 'mac'] as const;
export type ClientSentFrom = typeof CLIENT_SENT_FROM[number];
/** `meta.sentFrom` of a person typing in a Very Happy client (`mobile`: written by older app builds). */
export const OWNER_SENT_FROM = [...CLIENT_SENT_FROM, 'mobile'] as const;
/**
 * B-924e: every `meta.sentFrom` a program writes — never the owner, whatever it says. Together with
 * OWNER_SENT_FROM this is the full inventory (specs/2026-11-main-agent.md「sentFrom 盘点」); a test scans the
 * repo for `sentFrom` literals and fails on one that is in neither list.
 */
export const PROGRAM_SENT_FROM = [
    'cli', 'assistant', 'automation', 'team', 'issue', 'session-peer', 'shared', 'happy-agent',
] as const;
export const SUGGESTION_OPTION_LOCAL_ID_PREFIX = 'option-';
export const NON_OWNER_RETRY_LOCAL_ID_PREFIX = 'retry-';
/** localId prefixes that are never the owner typing, whatever `sentFrom` says (the CLI turn origin reads the same list). */
export const NON_OWNER_LOCAL_ID_PREFIXES = [
    'automation-', 'teams-', 'remote-send-', 'session-message-', 'edit-conflict-', 'wrapup-', 'handoff-',
    ATTENTION_BOARD_LOCAL_ID_PREFIX, SUGGESTION_OPTION_LOCAL_ID_PREFIX, NON_OWNER_RETRY_LOCAL_ID_PREFIX,
] as const;

function nonce(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
export function suggestionOptionLocalId(n: string = nonce()): string {
    return `${SUGGESTION_OPTION_LOCAL_ID_PREFIX}${n}`;
}
export function nonOwnerRetryLocalId(n: string = nonce()): string {
    return `${NON_OWNER_RETRY_LOCAL_ID_PREFIX}${n}`;
}

/**
 * The owner typed this message in a client: `sentFrom` is a client's and the localId carries no reserved
 * prefix. Fail-closed: a missing / unknown `sentFrom` is not the owner. (`sentFrom` is client-set: this is
 * provenance for an honest client, not authentication — B-927 stamps the sender's token kind on the server.)
 */
export function isOwnerTypedMessage(localId: string | null | undefined, sentFrom: string | null | undefined): boolean {
    const id = localId ?? '';
    if (NON_OWNER_LOCAL_ID_PREFIXES.some(prefix => id.startsWith(prefix))) return false;
    return typeof sentFrom === 'string' && (OWNER_SENT_FROM as readonly string[]).includes(sentFrom);
}

/** The localId 「重试」 sends: the owner's own message retries as the owner; anything else stays not the owner. */
export function retryLocalIdFor(original: { localId?: string | null; sentFrom?: string | null }): string | undefined {
    return isOwnerTypedMessage(original.localId, original.sentFrom) ? undefined : nonOwnerRetryLocalId();
}
