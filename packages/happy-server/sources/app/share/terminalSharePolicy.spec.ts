import { describe, expect, it } from 'vitest';
import {
    TerminalShareError,
    allowTerminalShareEvent,
    cwdBasename,
    planTerminalShareCall,
    terminalShareAuditPayload,
    terminalShareExpiry,
    viewOnlyCapable,
    webTerminalIds,
    webTerminalInfo,
} from './terminalSharePolicy';

const ctx = (over: Partial<Parameters<typeof planTerminalShareCall>[2]> = {}) => ({
    role: 'viewer' as const, terminalId: 't1', viewOnlyCapable: true, geometry: { cols: 132, rows: 40 }, ...over,
});
const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e instanceof TerminalShareError ? e.code : String(e); } };

describe('B-878 terminal share policy', () => {
    it('expiry: 1/7/30 only, defaults viewer 7 / operator 1, operator needs confirmation', () => {
        const now = 1_000_000;
        expect(terminalShareExpiry({ role: 'viewer' }, now).getTime()).toBe(now + 7 * 86_400_000);
        expect(terminalShareExpiry({ role: 'operator', confirmOperator: true }, now).getTime()).toBe(now + 86_400_000);
        expect(terminalShareExpiry({ role: 'viewer', expiresInDays: 30 }, now).getTime()).toBe(now + 30 * 86_400_000);
        for (const days of [null, 0, 2, 365, '7']) expect(code(() => terminalShareExpiry({ role: 'viewer', expiresInDays: days }, now))).toBe('bad_expiry');
        expect(code(() => terminalShareExpiry({ role: 'operator', expiresInDays: 1 }, now))).toBe('operator_requires_confirm');
    });

    it('viewer attach: always viewOnly at the reported pane size, never the request; pinned to the grant terminal', () => {
        const plan = planTerminalShareCall('attach', { terminalId: 'other', cols: 20, rows: 5, startupCommand: 'x', attachTmux: { id: '$1' }, cwd: '/', fromSeq: 3, resub: true }, ctx());
        expect(plan).toEqual({ method: 'open-terminal', params: { terminalId: 't1', encStream: true, attachOnly: true, viewOnly: true, cols: 132, rows: 40, fromSeq: 3, resub: true }, auditKind: undefined });
        expect(planTerminalShareCall('attach', {}, ctx({ geometry: null })).params).toMatchObject({ viewOnly: true, cols: 80, rows: 24 });
        expect(code(() => planTerminalShareCall('attach', {}, ctx({ viewOnlyCapable: false })))).toBe('cli_upgrade_required');
    });

    it('operator attach uses its own size and is never viewOnly', () => {
        const plan = planTerminalShareCall('attach', { cols: 100, rows: 30 }, ctx({ role: 'operator', viewOnlyCapable: false }));
        expect(plan.params).toEqual({ terminalId: 't1', encStream: true, attachOnly: true, cols: 100, rows: 30 });
        expect(plan.auditKind).toBe('terminal.attach');
    });

    it('allowlist per role; everything else is denied', () => {
        for (const op of ['scroll', 'paste', 'kill', 'open', 'list', 'kill-terminal', 'open-terminal', 'set-terminal-title', undefined, 42]) {
            expect(code(() => planTerminalShareCall(op, { lines: 1, text: 'x' }, ctx()))).toBe('share_method_denied');
        }
        for (const op of ['kill', 'open', 'list', 'kill-terminal']) expect(code(() => planTerminalShareCall(op, {}, ctx({ role: 'operator' })))).toBe('share_method_denied');
        expect(planTerminalShareCall('history', { terminalId: 'x', snapshotId: 's', page: 2 }, ctx()).params).toEqual({ terminalId: 't1', snapshotId: 's', page: 2 });
        expect(planTerminalShareCall('scroll', { lines: -3 }, ctx({ role: 'operator' })).params).toEqual({ terminalId: 't1', lines: -3 });
        expect(planTerminalShareCall('paste', { text: 'ls', terminalId: 'x' }, ctx({ role: 'operator' })).params).toEqual({ terminalId: 't1', text: 'ls' });
        expect(code(() => planTerminalShareCall('history', { page: 1 }, ctx()))).toBe('bad_params');
        expect(code(() => planTerminalShareCall('attach', 'x', ctx()))).toBe('bad_params');
    });

    it('events: a viewer may only unsubscribe', () => {
        expect(allowTerminalShareEvent('viewer', 'input')).toBe(false);
        expect(allowTerminalShareEvent('viewer', 'resize')).toBe(false);
        expect(allowTerminalShareEvent('viewer', 'close')).toBe(true);
        expect(allowTerminalShareEvent('operator', 'input')).toBe(true);
        expect(allowTerminalShareEvent('operator', 'resize')).toBe(true);
    });

    it('reads the daemon list only when this run wrote it; capability needs detectedAt >= startedAt', () => {
        const state = { startedAt: 10, webTerminals: { updatedAt: 11, terminals: [{ id: 't1', title: 'b', cwd: '/home/u/repo/', paneCols: 120, paneRows: 30, projectId: 'p' }, { id: 't2' }] }, terminalViewOnly: { rpcAvailable: true, detectedAt: 10 } };
        expect(webTerminalInfo(state, 't1')).toEqual({ title: 'b', cwd: '/home/u/repo/', cols: 120, rows: 30, projectId: 'p' });
        expect(webTerminalInfo(state, 't2')).toEqual({ title: null, cwd: null, cols: null, rows: null, projectId: null });
        expect(webTerminalInfo(state, 'nope')).toBeNull();
        expect([...webTerminalIds(state)!]).toEqual(['t1', 't2']);
        expect(webTerminalIds({ ...state, webTerminals: { updatedAt: 9, terminals: [] } })).toBeNull();
        expect(viewOnlyCapable(state)).toBe(true);
        expect(viewOnlyCapable({ ...state, terminalViewOnly: { rpcAvailable: true, detectedAt: 9 } })).toBe(false);
        expect(viewOnlyCapable({ startedAt: 1 })).toBe(false);
        expect(viewOnlyCapable(null)).toBe(false);
    });

    it('a grantee sees only the directory name; the audit payload carries no free text', () => {
        expect(cwdBasename('/home/u/repo/')).toBe('repo');
        expect(cwdBasename('C:\\Users\\u\\proj')).toBe('proj');
        expect(cwdBasename(null)).toBeNull();
        expect(terminalShareAuditPayload('g', { role: 'viewer', bytes: 3, text: 'secret', command: 'rm' })).toEqual({ grantId: 'g', role: 'viewer', bytes: 3 });
    });
});
