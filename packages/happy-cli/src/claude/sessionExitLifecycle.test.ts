import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionExitGate, exitIntentFromArchiveFlag, settleSessionOnExit } from './sessionExitLifecycle';

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
    it('offline: session-end + /deactivate only — no metadata stamp, never /archive', async () => {
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
        expect(runClaude).toContain('const intent = exitGate.claim(exitIntentFromArchiveFlag(opts.archive));');
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
