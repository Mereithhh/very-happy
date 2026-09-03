import { describe, expect, it } from 'vitest';
import { claudeAuthNotice } from './claudeAuthNotice';
import { CLAUDE_AUTH_STALE_AFTER_MS } from '@/sync/claudeAuth';

const NOW = 1_800_000_000_000;

function machine(claudeAuth: Record<string, unknown> | null, pid = 42) {
    return { daemonState: { pid, ...(claudeAuth ? { claudeAuth } : {}) } } as never;
}

function auth(over: Record<string, unknown> = {}) {
    return {
        probeVersion: 1,
        daemonPid: 42,
        status: 'not-logged-in',
        context: { platform: 'linux', lineage: 'other', credentialStore: 'auto' },
        checkedAt: NOW - 1000,
        ...over,
    };
}

describe('claudeAuthNotice', () => {
    it('warns when the daemon says this machine is not logged in', () => {
        expect(claudeAuthNotice(machine(auth({ diagnosis: 'credentials-rejected' })), 'claude', NOW))
            .toEqual({ kind: 'not-logged-in', diagnosis: 'credentials-rejected' });
        expect(claudeAuthNotice(machine(auth()), 'claude', NOW))
            .toEqual({ kind: 'not-logged-in', diagnosis: undefined });
    });

    it('warns when the probe itself is broken', () => {
        expect(claudeAuthNotice(machine(auth({ status: 'error' })), 'claude', NOW))
            .toEqual({ kind: 'unhealthy', status: 'error' });
        expect(claudeAuthNotice(machine(auth({ status: 'claude-missing' })), 'claude', NOW))
            .toEqual({ kind: 'unhealthy', status: 'claude-missing' });
    });

    it('stays silent for a healthy machine', () => {
        expect(claudeAuthNotice(machine(auth({ status: 'ok' })), 'claude', NOW)).toEqual({ kind: 'none' });
    });

    // Bedrock / API-key machines report `unknown` by design — the probe refuses
    // to call them not-logged-in, and neither may the picker.
    it('stays silent on a machine whose credential source is not a Claude login', () => {
        expect(claudeAuthNotice(machine(auth({ status: 'unknown', authMethod: 'Amazon Bedrock' })), 'claude', NOW))
            .toEqual({ kind: 'none' });
    });

    it('never warns from absence of information', () => {
        // Old CLI: no claudeAuth at all.
        expect(claudeAuthNotice(machine(null), 'claude', NOW)).toEqual({ kind: 'none' });
        expect(claudeAuthNotice(null, 'claude', NOW)).toEqual({ kind: 'none' });
        expect(claudeAuthNotice(undefined, 'claude', NOW)).toEqual({ kind: 'none' });
        // Written by a previous daemon run — the trust gate rejects it.
        expect(claudeAuthNotice(machine(auth({ daemonPid: 41 })), 'claude', NOW)).toEqual({ kind: 'none' });
        // Stale probe is not evidence.
        expect(claudeAuthNotice(machine(auth({ checkedAt: NOW - CLAUDE_AUTH_STALE_AFTER_MS - 1 })), 'claude', NOW))
            .toEqual({ kind: 'none' });
    });

    it('says nothing for agents that do not read the Claude login', () => {
        for (const agent of ['codex', 'gemini', 'openclaw'] as const) {
            expect(claudeAuthNotice(machine(auth()), agent, NOW)).toEqual({ kind: 'none' });
        }
    });
});
