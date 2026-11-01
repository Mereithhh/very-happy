import { describe, expect, it } from 'vitest';
import {
    AGENT_PROFILE_RPC,
    AGENT_PROFILE_SESSION_CAPABILITY,
    AgentProfileAddRequestSchema,
    AgentProfileLoginStartRequestSchema,
    AgentProfileLoginStatusSchema,
    AgentProfilesStateSchema,
    readAgentProfileStatus,
    readSessionAgentProfile,
} from './agentProfiles';

describe('B-850a agent profile wire', () => {
    it('names are stable (the Web gates on them)', () => {
        expect(AGENT_PROFILE_SESSION_CAPABILITY).toBe('agent-profile-v1');
        expect(AGENT_PROFILE_RPC).toEqual({
            list: 'agent-profile-list', add: 'agent-profile-add',
            loginStart: 'agent-profile-login-start', loginSubmit: 'agent-profile-login-submit',
            loginStatus: 'agent-profile-login-status', loginCancel: 'agent-profile-login-cancel',
            test: 'agent-profile-test', rename: 'agent-profile-rename', remove: 'agent-profile-remove',
            setDefault: 'agent-profile-set-default', bind: 'agent-profile-bind',
        });
    });

    it('metadata.agentProfile: undefined = old wrapper, null = machine login, unknown status still parses', () => {
        expect(readSessionAgentProfile(undefined)).toBeUndefined();
        expect(readSessionAgentProfile(null)).toBeNull();
        expect(readSessionAgentProfile({ id: 'a', label: 'A', kind: 'claude-future', status: 'new-state', extra: 1 })).toEqual({ id: 'a', label: 'A', kind: 'claude-future', status: 'new-state' });
        expect(readSessionAgentProfile({ id: 'a' })).toBeUndefined();
    });

    it('status whitelist falls back to unverified', () => {
        expect(readAgentProfileStatus('expired')).toBe('expired');
        expect(readAgentProfileStatus('something-new')).toBe('unverified');
    });

    it('daemonState shape tolerates future fields; add request rejects bad URLs and accepts the three key sources', () => {
        expect(AgentProfilesStateSchema.safeParse({ daemonPid: 1, updatedAt: 2, accounts: [{ id: 'a', label: 'A', agent: 'codex', kind: 'codex-chatgpt', status: 'ok', email: 'x' }], defaults: {} }).success).toBe(true);
        const base = { agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://h' };
        for (const key of [{ source: 'file', path: '~/k' }, { source: 'env', name: 'HUB_KEY' }, { source: 'paste', value: 'sk-x' }]) {
            expect(AgentProfileAddRequestSchema.safeParse({ ...base, key }).success).toBe(true);
        }
        expect(AgentProfileAddRequestSchema.safeParse({ ...base, baseUrl: 'file:///etc', key: { source: 'file', path: 'k' } }).success).toBe(false);
        expect(AgentProfileAddRequestSchema.safeParse({ ...base, key: { source: 'env', name: 'bad name' } }).success).toBe(false);
    });

    it('B-850b: Codex provider add needs provider or baseUrl; ChatGPT login start; device-code status fields', () => {
        const key = { source: 'file', path: '~/k' };
        expect(AgentProfileAddRequestSchema.safeParse({ agent: 'codex', kind: 'codex-provider', label: 'Hub', provider: 'llmhub', key }).success).toBe(true);
        expect(AgentProfileAddRequestSchema.safeParse({ agent: 'codex', kind: 'codex-provider', label: 'Own', baseUrl: 'https://x/v1', wireApi: 'chat', key }).success).toBe(true);
        expect(AgentProfileAddRequestSchema.safeParse({ agent: 'codex', kind: 'codex-provider', label: 'None', key }).success).toBe(false);
        expect(AgentProfileAddRequestSchema.safeParse({ agent: 'codex', kind: 'claude-api', label: 'Mixed', baseUrl: 'https://x', key }).success).toBe(false);
        expect(AgentProfileLoginStartRequestSchema.safeParse({ agent: 'codex', kind: 'codex-chatgpt' }).success).toBe(true);
        expect(AgentProfileLoginStartRequestSchema.safeParse({ agent: 'codex', kind: 'claude-subscription' }).success).toBe(false);
        expect(AgentProfileLoginStatusSchema.parse({ loginId: 'l', state: 'waiting-code', flow: 'device-code', url: 'https://auth.openai.com/codex/device', userCode: 'AB-12', extra: 1 }))
            .toEqual({ loginId: 'l', state: 'waiting-code', flow: 'device-code', url: 'https://auth.openai.com/codex/device', userCode: 'AB-12' });
        expect(AgentProfilesStateSchema.safeParse({ daemonPid: 1, updatedAt: 2, accounts: [], defaults: { codex: 'hub' }, codexProviders: [{ id: 'llmhub', envKey: 'LLMHUB_API_KEY' }] }).success).toBe(true);
        expect(AgentProfilesStateSchema.parse({ daemonPid: 1, updatedAt: 2, accounts: [], defaults: {}, kinds: ['claude-api', 'codex-provider'] }).kinds).toEqual(['claude-api', 'codex-provider']);
    });
});
