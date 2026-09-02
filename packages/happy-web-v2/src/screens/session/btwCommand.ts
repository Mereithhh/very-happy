/**
 * `/btw` composer command + capability gate (B-283). Pure; the composer and
 * the detail screen consume it.
 */
import type { Session } from '@/sync/storageTypes';

export const BTW_CAPABILITY = 'claude-btw-v1';
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

/** A structured Claude session (any CLI version) can HOST the panel. */
export function canOfferBtw(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    const flavor = session?.metadata?.flavor;
    return !flavor || flavor === 'claude';
}

/** The wrapper actually answers side questions (new CLI, per-session — B-283 / 铁律 14). */
export function supportsBtw(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    return canOfferBtw(session) && session?.metadata?.capabilities?.includes(BTW_CAPABILITY) === true;
}
