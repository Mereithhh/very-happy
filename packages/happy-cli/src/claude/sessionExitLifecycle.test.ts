import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OFFLINE_EXIT_STAMP_TIMEOUT_MS, SessionExitGate, exitIntentFromArchiveFlag, settleSessionOnExit } from './sessionExitLifecycle';
import type { Metadata } from '@/api/types';

/**
 * B-505 regression. 2026-09-25 13:06:44Z, dev-sg: `very-happy daemon stop` for
 * the 0.2.155 upgrade → systemd (`KillMode=control-group`) SIGTERMed every
 * wrapper in the unit's cgroup → wrapper cleanup(archive=false) still POSTed
 * `/archive` (the pre-B-265 "belt and braces" for session-end) → the server
 * wrote `archivedAt` and answered `session-archive` → the wrapper re-entered
 * cleanup(archive=true). Two sessions mid-turn were archived; the Owner had
 * to restore them by hand. Same thing at 11:08Z for 0.2.154.
 */
function deps() {
    return {
        updateMetadata: vi.fn(),
        sendSessionDeath: vi.fn(),
        archiveSession: vi.fn(async () => true),
        deactivateSession: vi.fn(async () => true),
        log: vi.fn(),
    };
}

describe('settleSessionOnExit', () => {
    it('offline (no B-679 cursor dep): session-end + /deactivate only — no metadata stamp, never /archive', async () => {
        const d = deps();
        await settleSessionOnExit('s1', 'offline', d);
        expect(d.sendSessionDeath).toHaveBeenCalledTimes(1);
        expect(d.deactivateSession).toHaveBeenCalledWith('s1');
        expect(d.archiveSession).not.toHaveBeenCalled();
        expect(d.updateMetadata).not.toHaveBeenCalled();
    });

    it('archive: stamps lifecycleState=archived, session-end, then /archive', async () => {
        const d = deps();
        await settleSessionOnExit('s1', 'archive', d);
        expect(d.updateMetadata).toHaveBeenCalledTimes(1);
        const stamped = d.updateMetadata.mock.calls[0][0]({ flavor: 'claude' } as never);
        expect(stamped).toMatchObject({ flavor: 'claude', lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'User terminated' });
        expect(d.sendSessionDeath).toHaveBeenCalledTimes(1);
        expect(d.archiveSession).toHaveBeenCalledWith('s1');
        expect(d.deactivateSession).not.toHaveBeenCalled();
    });

    it('a failing HTTP fallback is logged, not thrown (the process must still exit cleanly)', async () => {
        const d = deps();
        d.deactivateSession.mockRejectedValueOnce(new Error('ECONNRESET'));
        await expect(settleSessionOnExit('s1', 'offline', d)).resolves.toBeUndefined();
        expect(d.log).toHaveBeenCalledWith(expect.stringContaining('deactivateSession during cleanup failed'), expect.any(Error));
    });
});

describe('SessionExitGate', () => {
    it('the first intent wins; a later archive cannot escalate an offline exit', () => {
        const gate = new SessionExitGate();
        expect(gate.claim('offline')).toBe('offline');
        // the server's session-archive echo / a crash handler during teardown
        expect(gate.claim('archive')).toBeNull();
        expect(gate.current).toBe('offline');
    });

    it('an explicit archive is not downgraded by a later signal either', () => {
        const gate = new SessionExitGate();
        expect(gate.claim('archive')).toBe('archive');
        expect(gate.claim('offline')).toBeNull();
        expect(gate.current).toBe('archive');
    });
});

describe('exitIntentFromArchiveFlag', () => {
    it('maps the legacy cleanup flag (default archive)', () => {
        expect(exitIntentFromArchiveFlag(undefined)).toBe('archive');
        expect(exitIntentFromArchiveFlag(true)).toBe('archive');
        expect(exitIntentFromArchiveFlag(false)).toBe('offline');
    });
});

describe('runClaude / api wiring', () => {
    const runClaude = readFileSync(join(__dirname, 'runClaude.ts'), 'utf8');
    const api = readFileSync(join(__dirname, '..', 'api', 'api.ts'), 'utf8');

    it('SIGTERM and SIGINT are offline exits, kill RPC and crashes are archive exits', () => {
        expect(runClaude).toContain("process.on('SIGTERM', () => { void cleanup({ archive: false }); });");
        expect(runClaude).toContain("process.on('SIGINT', () => { void cleanup({ archive: false }); });");
        expect(runClaude).toContain("registerKillSessionHandler(session.rpcHandlerManager, () => cleanup({ archive: true }), session);");
    });

    it('cleanup claims the intent through the gate before doing anything', () => {
        // B-587: only a hibernation (which claimed the gate in commitHibernation) bypasses the claim here.
        expect(runClaude).toContain("const intent = opts.hibernation ? 'hibernate' as const : exitGate.claim(exitIntentFromArchiveFlag(opts.archive));");
        expect(runClaude).toContain("claimExit: () => exitGate.claim('hibernate') !== null,");
        expect(runClaude).toContain('if (intent === null) {');
        expect(runClaude).toContain('await settleSessionOnExit(session.sessionId, intent, {');
        // the archive route is reachable only through the lifecycle module
        expect(runClaude).not.toContain('api.deactivateSession(session.sessionId)');
        expect(runClaude).not.toContain("lifecycleState: 'archived'");
    });

    it('deactivateSession posts to /deactivate and treats 404 (older server) as a no-op', () => {
        const start = api.indexOf('async deactivateSession(sessionId: string)');
        const body = api.slice(start, api.indexOf('async archiveSession(sessionId: string)'));
        expect(body).toContain('/v1/sessions/${sessionId}/deactivate`');
        expect(body).not.toContain('/archive`');
        expect(body).toContain('status === 404');
    });

    it('archiveSession is the only /archive caller', () => {
        const start = api.indexOf('async archiveSession(sessionId: string)');
        expect(api.slice(start, start + 800)).toContain('/v1/sessions/${sessionId}/archive`');
        expect(api.match(/\/v1\/sessions\/\$\{sessionId\}\/archive`/g)).toHaveLength(1);
    });
});

describe('B-679 offline exit cursor', () => {
    const exitCursor = { at: 1_000, seq: 21, v: 1 as const };

    it('stamps metadata.exitCursor (awaited, short bound) BEFORE session-end, then /deactivate — never archived', async () => {
        const order: string[] = [];
        const d = {
            ...deps(),
            sendSessionDeath: vi.fn(() => { order.push('session-end'); }),
            deactivateSession: vi.fn(async () => { order.push('deactivate'); return true; }),
            updateMetadataAndWait: vi.fn(async (_handler: (metadata: Metadata) => Metadata, _timeoutMs?: number) => { order.push('stamp'); return true; }),
            exitCursor,
        };
        await settleSessionOnExit('s1', 'offline', d);
        expect(order).toEqual(['stamp', 'session-end', 'deactivate']);
        expect(d.updateMetadataAndWait.mock.calls[0][1]).toBe(OFFLINE_EXIT_STAMP_TIMEOUT_MS);
        const written = d.updateMetadataAndWait.mock.calls[0][0]({ flavor: 'claude', lifecycleState: 'running' } as never);
        expect(written).toEqual({ flavor: 'claude', lifecycleState: 'running', exitCursor });
        expect(d.archiveSession).not.toHaveBeenCalled();
    });

    it('archive exits never write the cursor; a stamp that times out still goes offline', async () => {
        const a = { ...deps(), updateMetadataAndWait: vi.fn(async () => true), exitCursor };
        await settleSessionOnExit('s1', 'archive', a);
        expect(a.updateMetadataAndWait).not.toHaveBeenCalled();
        const o = { ...deps(), updateMetadataAndWait: vi.fn(async () => false), exitCursor };
        await settleSessionOnExit('s1', 'offline', o);
        expect(o.deactivateSession).toHaveBeenCalledWith('s1');
    });

    it('runClaude pins the cursor and freezes inbound in the same tick, hands it to settle, and bounds the B-332 scan on replay', () => {
        const src = readFileSync(join(__dirname, 'runClaude.ts'), 'utf8').replace(/\/\/.*$/gm, '');
        expect(src).toContain("const exitCursor = intent === 'offline' ? exitCursorStamp(session.messageCursor, Date.now()) : undefined;\n                if (exitCursor) session.freezeInbound();");
        expect(src).toMatch(/updateMetadataAndWait: \(handler, timeoutMs\) => session\.updateMetadataAndWait\(handler, timeoutMs\),\s*exitCursor,/);
        expect(src).toContain('const wake = applyReconnectReplay(response);');
        expect(src).toContain('void session.cancelUndeliveredQueuedInputs(reconnectReplay ? { maxSeq: reconnectReplay.seq } : undefined);');
    });
});

describe('B-587 hibernate exit', () => {
    const stamp = { at: 1_000, seq: 42, idleMs: 3_600_000, v: 1 as const };

    it('stamps metadata.hibernation (awaited) BEFORE session-end, then /deactivate — never /archive or archived lifecycle', async () => {
        const order: string[] = [];
        const d = {
            ...deps(),
            sendSessionDeath: vi.fn(() => { order.push('session-end'); }),
            deactivateSession: vi.fn(async () => { order.push('deactivate'); return true; }),
            updateMetadataAndWait: vi.fn(async (_handler: (metadata: Metadata) => Metadata) => { order.push('stamp'); return true; }),
            hibernation: stamp,
        };
        await settleSessionOnExit('s1', 'hibernate', d);
        expect(order).toEqual(['stamp', 'session-end', 'deactivate']);
        expect(d.archiveSession).not.toHaveBeenCalled();
        const written = d.updateMetadataAndWait.mock.calls[0][0]({ flavor: 'claude', lifecycleState: 'running' } as never);
        expect(written).toEqual({ flavor: 'claude', lifecycleState: 'running', hibernation: stamp });
    });

    it('a stamp that does not land in time still goes offline (plain offline is recoverable)', async () => {
        const d = { ...deps(), updateMetadataAndWait: vi.fn(async () => false), hibernation: stamp };
        await settleSessionOnExit('s1', 'hibernate', d);
        expect(d.deactivateSession).toHaveBeenCalledWith('s1');
        expect(d.archiveSession).not.toHaveBeenCalled();
    });

    it('the gate defers exits while a hibernation decides and hands them back on abort (review P1-1)', () => {
        const gate = new SessionExitGate();
        expect(gate.claim('hibernate')).toBe('hibernate');
        expect(gate.claim('offline')).toBeNull();
        expect(gate.claim('archive')).toBeNull();
        expect(gate.exitRequested).toBe(true);
        expect(gate.release('offline')).toBeNull();
        expect(gate.current).toBe('hibernate');
        expect(gate.release('hibernate')).toBe('archive');
        expect(gate.claim('archive')).toBe('archive');
        expect(gate.release('hibernate')).toBeNull();
        expect(gate.current).toBe('archive');
    });

    it('a committed hibernation keeps the gate: later exits are dropped, release is a no-op', () => {
        const gate = new SessionExitGate();
        gate.claim('hibernate');
        gate.commitHibernate();
        expect(gate.claim('archive')).toBeNull();
        expect(gate.exitRequested).toBe(false);
        expect(gate.release('hibernate')).toBeNull();
        expect(gate.current).toBe('hibernate');
    });
});
