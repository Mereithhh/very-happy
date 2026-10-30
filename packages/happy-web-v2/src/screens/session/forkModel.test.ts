import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { forkFailureKind, forkReasonText, isForkableFlavor, resolveForkPoint, sessionForkBlock } from './forkModel';

const claude = { id: 's', metadata: { machineId: 'm', path: '/repo', flavor: 'claude', claudeSessionId: 'c' } } as unknown as Session;
const ok = { machineOnline: true, running: false };

describe('B-851 sessionForkBlock', () => {
    it('forks Claude and Codex with their own conversation ids', () => {
        expect(sessionForkBlock(claude, ok)).toEqual({ source: { kind: 'claude', sessionId: 's', machineId: 'm', directory: '/repo', claudeSessionId: 'c' } });
        const codex = { ...claude, metadata: { ...claude.metadata!, flavor: 'codex', codexThreadId: 't' } } as Session;
        expect(sessionForkBlock(codex, ok)).toMatchObject({ source: { kind: 'codex', codexThreadId: 't' } });
    });
    it('explains each reason it cannot, most fundamental first', () => {
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, flavor: 'pi' } } as Session, ok)).toBe('unsupported');
        expect(sessionForkBlock(null, ok)).toBe('unsupported');
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, claudeSessionId: undefined } } as Session, { machineOnline: false, running: true })).toBe('noHistory');
        // a Codex session never carries a stale Claude id into a Claude fork
        expect(sessionForkBlock({ ...claude, metadata: { ...claude.metadata!, flavor: 'codex' } } as Session, ok)).toBe('noHistory');
        expect(sessionForkBlock(claude, { machineOnline: false, running: true })).toBe('offline');
        expect(sessionForkBlock(claude, { machineOnline: true, running: true })).toBe('running');
    });
    it('treats a session without flavor as Claude (pre-flavor sessions)', () => {
        expect(isForkableFlavor(undefined)).toBe(true);
        expect(isForkableFlavor('gemini')).toBe(false);
    });
});

describe('B-851 resolveForkPoint', () => {
    const prompts = [{ id: 'a', text: 'first' }, { id: 'b', text: 'continue' }, { id: 'c', text: 'continue' }];
    it('takes the same position when both sides hold the same prompts (Codex hides the first prompt behind its instructions)', () => {
        const points = [{ id: 'p1', text: '# Options …instructions…' }, { id: 'p2', text: 'continue' }, { id: 'p3', text: 'continue' }];
        expect(resolveForkPoint(prompts, 'a', points)).toBe('p1');
        expect(resolveForkPoint(prompts, 'c', points)).toBe('p3');
    });
    it('pairs prompts in order when the counts differ, so repeated text maps 1:1', () => {
        const points = [{ id: 'p0', text: 'typed in the terminal' }, { id: 'p1', text: 'first' }, { id: 'p2', text: 'continue' }, { id: 'p3', text: 'continue' }];
        expect(resolveForkPoint(prompts, 'b', points)).toBe('p2');
        expect(resolveForkPoint(prompts, 'c', points)).toBe('p3');
    });
    it('never lands a short prompt on an earlier, longer one that contains it', () => {
        const ask = [{ id: 'a', text: 'please say ok when done' }, { id: 'b', text: 'ok' }];
        const points = [{ id: 'x', text: 'extra' }, { id: 'p1', text: 'please say ok when done' }, { id: 'p2', text: 'ok' }];
        expect(resolveForkPoint(ask, 'b', points)).toBe('p2');
    });
    it('accepts a wrapper prefix and whitespace differences', () => {
        const points = [{ id: 'p0', text: 'x' }, { id: 'p1', text: '[project: demo]\nfirst' }, { id: 'p2', text: 'continue  ' }];
        expect(resolveForkPoint(prompts.slice(0, 2), 'b', points)).toBe('p2');
    });
    it('returns null rather than guessing', () => {
        expect(resolveForkPoint(prompts, 'missing', [{ id: 'p1', text: 'first' }])).toBeNull();
        expect(resolveForkPoint(prompts, 'b', [{ id: 'p1', text: 'first' }])).toBeNull();
    });
});

describe('B-851 failure copy', () => {
    it('tells an outdated CLI from an offline or unreachable machine', () => {
        expect(forkFailureKind('Method not found', true)).toBe('outdated');
        // CLI before B-851 on Codex ≥ 0.154
        expect(forkFailureKind('thread/rollback: paginated threads do not support thread/rollback (code=-32600)', true)).toBe('outdated');
        expect(forkFailureKind('RPC method not available', false)).toBe('offline');
        // the machine flag lags a stopped daemon: name both causes
        expect(forkFailureKind('RPC method not available', true)).toBe('unreachable');
        expect(forkFailureKind('Claude session file not found on this machine', true)).toBe('failed');
    });
    it('keeps the machine’s words only for a generic failure', () => {
        const t = (key: string) => key;
        expect(forkReasonText(t as never, 'failed', 'disk full')).toBe('session.forkErrorGeneric disk full');
        expect(forkReasonText(t as never, 'outdated', 'Method not found')).toBe('session.forkErrorOutdated');
        expect(forkReasonText(t as never, 'offline')).toBe('session.forkErrorOffline');
    });
});
