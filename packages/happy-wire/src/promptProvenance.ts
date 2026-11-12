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

/** `meta.sentFrom` of a person typing in a Very Happy client. */
export const OWNER_SENT_FROM = ['web', 'mobile', 'ios', 'android'] as const;
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
