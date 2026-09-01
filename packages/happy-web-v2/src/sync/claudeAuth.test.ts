import { describe, expect, it } from 'vitest';
import { claudeAuthTone, parseClaudeAuth } from './claudeAuth';

const base = {
    probeVersion: 1, daemonPid: 42, status: 'ok', authMethod: 'claude.ai', subscriptionType: 'max',
    context: { platform: 'darwin', lineage: 'launchd', credentialStore: 'auto' }, checkedAt: 1000,
};

describe('parseClaudeAuth (B-276 trust gate)', () => {
    it('accepts a value written by the current daemon run', () => {
        expect(parseClaudeAuth({ pid: 42, claudeAuth: base })).toEqual(base);
    });
    it('rejects a stale value carried forward by another daemon run (rollback / restart)', () => {
        expect(parseClaudeAuth({ pid: 43, claudeAuth: base })).toBeNull();
        expect(parseClaudeAuth({ claudeAuth: base })).toBeNull();
    });
    it('returns null for old CLIs and malformed payloads', () => {
        expect(parseClaudeAuth({ pid: 42 })).toBeNull();
        expect(parseClaudeAuth(null)).toBeNull();
        expect(parseClaudeAuth({ pid: 42, claudeAuth: { ...base, probeVersion: 0 } })).toBeNull();
        expect(parseClaudeAuth({ pid: 42, claudeAuth: { status: 'ok' } })).toBeNull();
    });
    it('tolerates unknown status strings (forward compatibility)', () => {
        expect(parseClaudeAuth({ pid: 42, claudeAuth: { ...base, status: 'something-new' } })?.status).toBe('something-new');
        expect(claudeAuthTone({ ...base, status: 'something-new' }, 1000)).toBe('muted');
    });
    it('tones: ok live, failures err, unknown muted, stale warn', () => {
        expect(claudeAuthTone(base, 1000)).toBe('live');
        expect(claudeAuthTone({ ...base, status: 'not-logged-in' }, 1000)).toBe('err');
        expect(claudeAuthTone({ ...base, status: 'unknown' }, 1000)).toBe('muted');
        expect(claudeAuthTone(base, 1000 + 61 * 60 * 1000)).toBe('warn');
    });
});
