/**
 * `/btw` composer command + capability gate (B-283). Pure; the composer and
 * the detail screen consume it.
 */
import { CODEX_BTW_CAPABILITY } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';

export const BTW_CAPABILITY = 'claude-btw-v1';
export { CODEX_BTW_CAPABILITY };
export const BTW_COMMAND = 'btw';

const BTW_RE = /^\/btw(?:\s+([\s\S]*))?$/i;

/**
 * `/btw` → open the panel; `/btw <question>` → open AND ask. Null for any
 * other text (including `/btwx`), so the composer sends it as usual.
 */
export function parseBtwCommand(text: string): { question: string } | null {
    const match = text.trim().match(BTW_RE);
    if (!match) return null;
    return { question: (match[1] ?? '').trim() };
}

/**
 * A structured Claude or Codex session (any CLI version) can HOST the panel —
 * B-861 added Codex; an old Codex wrapper gets the same upgrade notice as an
 * old Claude one, and `/btw` never reaches its main thread.
 */
export function canOfferBtw(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    const flavor = session?.metadata?.flavor;
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

/** The wrapper actually answers side questions (new CLI, per-session — B-283 / 铁律 14). */
export function supportsBtw(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    if (!canOfferBtw(session)) return false;
    const capability = session?.metadata?.flavor === 'codex' ? CODEX_BTW_CAPABILITY : BTW_CAPABILITY;
    return session?.metadata?.capabilities?.includes(capability) === true;
}
