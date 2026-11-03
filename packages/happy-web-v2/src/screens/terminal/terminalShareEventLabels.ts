/** B-878: activity-log labels of terminal share events. Pure (no UI imports). */
import type { SimpleTranslationKey } from '@/text';

const EVENT_LABEL: Record<string, SimpleTranslationKey> = {
    'grant.create': 'share.terminal.event.create',
    'grant.accept': 'share.terminal.event.accept',
    'grant.decline': 'share.terminal.event.decline',
    'grant.update': 'share.terminal.event.update',
    'terminal.attach': 'share.terminal.event.attach',
    'terminal.paste': 'share.terminal.event.paste',
    'terminal.input': 'share.terminal.event.input',
    ended: 'share.terminal.event.ended',
};

/** Pure: the label key of an event kind (unknown kinds from a newer server read as "other"). */
export function terminalShareEventLabelKey(kind: string): SimpleTranslationKey {
    return EVENT_LABEL[kind] ?? 'share.terminal.event.other';
}
