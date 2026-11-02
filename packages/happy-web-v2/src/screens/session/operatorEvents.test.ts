/**
 * B-867c: the owner's activity log — `ended` and `terminal.gone` have labels,
 * an end reason is translated (no raw "downgraded"), a file-panel bash shows
 * its command; the "End their operation" chip sends endOperation (recorded as
 * ended_by_owner) and the operator's terminal dialog reacts to any tab ending.
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';
import { eventDetail, operatorEndReasonKey, operatorEventLabelKey } from './operatorEvents';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const lookup = (dict: unknown, key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
const ev = (kind: string, detail: Record<string, unknown>) => ({ id: 'e', kind, actorAccountId: 'a', detail, at: 0 });
const t = (key: string) => key;

describe('B-867c operator activity log', () => {
    it('ended / terminal.gone have their own labels in both languages', () => {
        for (const kind of ['ended', 'terminal.gone']) {
            const key = operatorEventLabelKey(kind);
            expect(key).not.toBe('share.operator.event.other');
            expect(typeof lookup(en, key)).toBe('string');
            expect(typeof lookup(zhHans, key)).toBe('string');
        }
    });

    it('every end reason the server sends is translated in both languages', () => {
        for (const reason of ['revoked', 'downgraded', 'ended_by_owner', 'expired', 'archived', 'deleted']) {
            const key = operatorEndReasonKey(reason)!;
            expect(key).toBeTruthy();
            expect(typeof lookup(en, key)).toBe('string');
            expect(typeof lookup(zhHans, key)).toBe('string');
            expect(eventDetail(ev('ended', { reason, killed: 1 }) as never, t as never)).toBe(key);
        }
        expect(operatorEndReasonKey('something-new')).toBeNull();
        expect(eventDetail(ev('ended', { reason: 'something-new' }) as never, t as never)).toBe('something-new');
    });

    it('a file-panel bash shows the command the operator ran', () => {
        expect(eventDetail(ev('bash', { path: '/repo', command: 'git status', commandBytes: 10 }) as never, t as never)).toBe('git status');
        expect(eventDetail(ev('bash', { path: '/repo' }) as never, t as never)).toBe('/repo');
        expect(eventDetail(ev('file.write', { path: '/repo/a' }) as never, t as never)).toBe('/repo/a');
    });

    it('the chip ends with endOperation; the share dialog toggle does not', () => {
        expect(read('./OperatorPresenceChip.tsx')).toContain('await setOperate(sessionId, accountId, false, undefined, { endOperation: true });');
        expect(read('../../sync/sessionSharesStore.ts')).toContain(": { operate: false, ...(opts?.endOperation ? { endOperation: true as const } : {}) });");
    });

    it('the operator terminal dialog drops any ended tab and says when it was closed on the owner\'s machine', () => {
        const src = read('./OperatorTerminal.tsx');
        expect(src).toContain("useEffect(() => onOperatorEvent('exit', (e) => {\n        if (e.sessionId !== sessionId) return;\n        setTerminals((list) => list.filter((x) => x.terminalId !== e.terminalId));");
        expect(src).toContain("toast.show(e.reason === 'closed_on_machine' ? t('share.operator.terminalClosedOnMachine', { owner }) : t('share.operator.terminalEnded'));");
    });
});
