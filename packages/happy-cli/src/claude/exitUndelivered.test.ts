/**
 * B-940b — an exiting wrapper never drops what it received but did not hand
 * to Claude Code (QA-T R65 ③ P2: a held session message was lost on
 * `sessions stop`, the sender saw `delivered`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planExitUndelivered } from './exitUndelivered';

const client = (known: Record<string, number>) => ({
    handOverUndelivered: vi.fn((ids: readonly string[]) => ({
        redeliver: ids.filter((id) => id in known).map((localId) => ({ seq: known[localId], localId })),
        unreplayable: ids.filter((id) => !(id in known)),
    })),
});

describe('planExitUndelivered (B-940b)', () => {
    it('offline exit: hands the known ones to the next wrapper, tombstones the rest as restarted', () => {
        const c = client({ p1: 12, o1: 13 });
        expect(planExitUndelivered('offline', ['p1', 'o1', 'p1', 'x', ''], c)).toEqual({
            redeliver: [{ seq: 12, localId: 'p1' }, { seq: 13, localId: 'o1' }],
            tombstone: ['x'],
            reason: 'restarted',
        });
        expect(c.handOverUndelivered).toHaveBeenCalledWith(['p1', 'o1', 'x']);
    });

    it('archive (crash / kill): no next wrapper — every one is marked not delivered', () => {
        const c = client({ p1: 12 });
        expect(planExitUndelivered('archive', ['p1'], c)).toEqual({ redeliver: [], tombstone: ['p1'], reason: 'aborted' });
        expect(c.handOverUndelivered).not.toHaveBeenCalled();
    });

    it('hibernate / superseded / nothing held: no-op', () => {
        for (const intent of ['hibernate', 'superseded'] as const) {
            expect(planExitUndelivered(intent, ['p1'], client({ p1: 1 }))).toEqual({ redeliver: [], tombstone: [], reason: 'aborted' });
        }
        expect(planExitUndelivered('offline', [], client({}))).toEqual({ redeliver: [], tombstone: [], reason: 'aborted' });
    });
});

describe('B-940b exit wiring (source assertions; mutation-checked, see PR)', () => {
    const strip = (src: string) => src.replace(/\/\/.*$/gm, '');
    const runClaude = strip(readFileSync(join(__dirname, 'runClaude.ts'), 'utf8'));
    const launcher = strip(readFileSync(join(__dirname, 'claudeRemoteLauncher.ts'), 'utf8'));

    it('runClaude lists the queue AND the launcher\'s held prompts before stamping, and stamps them on the exit cursor', () => {
        expect(runClaude).toContain('const exitDisposal = planExitUndelivered(intent, [...messageQueue.pendingSourceIds(), ...(currentSession?.undeliveredSourceIds() ?? [])], session);\n                const exitCursor = intent === \'offline\' ? exitCursorStamp(session.messageCursor, Date.now(), exitDisposal.redeliver) : undefined;');
        expect(runClaude).toContain('session.sendQueueCancelReason(exitDisposal.tombstone, exitDisposal.reason);');
    });

    it('a resumed wrapper re-routes the held ones (redeliver) and keeps them out of the B-332 tombstone scan', () => {
        expect(runClaude).toContain('...(reconnectReplay?.redeliver ? { redeliver: reconnectReplay.redeliver } : {})');
        expect(runClaude).toContain('...(reconnectReplay.redeliver ? { keep: reconnectReplay.redeliver.localIds } : {}),');
    });

    it('the launcher reports the live Query\'s held / in-hand prompts and the parked one', () => {
        expect(launcher).toContain('session.setUndeliveredProbe(() => [...(liveUndelivered?.() ?? []), ...parkedSourceIds()]);');
        expect(launcher).toContain('liveUndelivered = q.undeliveredSourceIds;');
        expect(launcher).toMatch(/uuid: promptUuidFor\(msg\.sourceIds\),\s*sourceIds: msg\.sourceIds,\s*\.\.\.\(msg\.nonUser/);
    });

    it('the misleading "replaying it in the next launch" log is gone', () => {
        expect(readFileSync(join(__dirname, 'claudeRemoteLauncher.ts'), 'utf8')).not.toContain('replaying it in the next launch');
    });
});
