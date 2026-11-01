import { describe, expect, it } from 'vitest';
import {
    accountChoiceDisplay,
    accountChoiceGate,
    accountChoiceOptions,
    automationRefusalReason,
    choiceKey,
    decodeAccountChoice,
    encodeAccountChoice,
    entryChoice,
    keyToAccountChoice,
    memberBindTarget,
    memberNeedsLiveSwitch,
    projectAccountEntry,
    projectAccountsChanged,
    projectAccountsOf,
    sameAccountChoice,
    teamAccountItemFacts,
    withProjectAccount,
    FOLLOW_KEY,
    MACHINE_LOGIN_KEY,
} from './accountChoice';
import { parseAgentProfilesState, projectSpawnAccount, resolveSpawnAccount, spawnAccountSource, spawnAgentProfileParam, type AgentProfilesState } from './agentProfiles';

const NOW = 1_800_000_000_000;

function stateOf(extra: Partial<Record<string, unknown>> = {}): AgentProfilesState {
    return parseAgentProfilesState({
        daemonPid: 1,
        updatedAt: NOW,
        accounts: [
            { id: 'org-a', label: 'Org A (renamed)', agent: 'claude', kind: 'claude-api', status: 'ok' },
            { id: 'org-b', label: 'Org B', agent: 'claude', kind: 'claude-api', status: 'missing-secret' },
            { id: 'gpt', label: 'GPT', agent: 'codex', kind: 'codex-chatgpt', status: 'ok' },
        ],
        defaults: { claude: 'org-a' },
        kinds: ['claude-subscription', 'claude-api', 'codex-chatgpt', 'codex-provider'],
        features: ['launch-accounts'],
        ...extra,
    })!;
}

describe('B-850e gate: launch-accounts', () => {
    it('ok only with the feature; accounts without it = upgrade; no accounts = none', () => {
        expect(accountChoiceGate(stateOf(), 'claude')).toBe('ok');
        expect(accountChoiceGate(stateOf({ features: undefined }), 'claude')).toBe('upgrade');
        expect(accountChoiceGate(stateOf({ features: ['something-else', 7] }), 'claude')).toBe('upgrade');
        expect(accountChoiceGate(null, 'claude')).toBe('none');
        // A B-850a daemon (Claude kinds only) has no Codex accounts at all.
        expect(accountChoiceGate(stateOf({ kinds: ['claude-subscription', 'claude-api'] }), 'codex')).toBe('none');
    });
});

describe('B-850e label: live label first, Ref.label only as fallback', () => {
    it('renamed account shows the live label; a removed one keeps the snapshot and says missing', () => {
        expect(accountChoiceDisplay({ id: 'org-a', label: 'Org A' }, stateOf(), NOW)).toMatchObject({ kind: 'account', label: 'Org A (renamed)', missing: false, status: 'ok' });
        expect(accountChoiceDisplay({ id: 'gone', label: 'Old' }, stateOf(), NOW)).toEqual({ kind: 'account', label: 'Old', missing: true, status: null });
        expect(accountChoiceDisplay({ id: 'gone' }, stateOf(), NOW)).toMatchObject({ label: 'gone' });
        // Machine unknown / old CLI: the snapshot, not flagged missing (we cannot tell).
        expect(accountChoiceDisplay({ id: 'org-a', label: 'Org A' }, null, NOW)).toMatchObject({ label: 'Org A', missing: false });
        expect(accountChoiceDisplay(null, stateOf())).toEqual({ kind: 'machine-login' });
        expect(accountChoiceDisplay(undefined, stateOf())).toEqual({ kind: 'follow' });
    });

    it('picking an account stores the live label as the snapshot', () => {
        expect(keyToAccountChoice('org-a', stateOf(), undefined)).toEqual({ id: 'org-a', label: 'Org A (renamed)' });
        expect(keyToAccountChoice(FOLLOW_KEY, stateOf(), { id: 'x' })).toBeUndefined();
        expect(keyToAccountChoice(MACHINE_LOGIN_KEY, stateOf(), undefined)).toBeNull();
        expect(keyToAccountChoice('gone', stateOf(), { id: 'gone', label: 'Old' })).toEqual({ id: 'gone', label: 'Old' });
        expect(choiceKey(undefined)).toBe(FOLLOW_KEY);
        expect(choiceKey(null)).toBe(MACHINE_LOGIN_KEY);
        expect(choiceKey({ id: 'org-a' })).toBe('org-a');
    });

    it('options: follow, machine login, this agent\'s accounts (unusable flagged), a vanished current ref kept', () => {
        const opts = accountChoiceOptions(stateOf(), 'claude', { id: 'gone', label: 'Old' }, { follow: 'F', machineLogin: 'M' }, NOW);
        expect(opts.map((o) => o.key)).toEqual([FOLLOW_KEY, MACHINE_LOGIN_KEY, 'org-a', 'org-b', 'gone']);
        expect(opts.find((o) => o.key === 'org-b')?.unusable).toBe(true);
        expect(opts.find((o) => o.key === 'org-a')?.unusable).toBeUndefined();
        expect(opts.find((o) => o.key === 'gone')).toMatchObject({ missing: true, label: 'Old' });
        expect(accountChoiceOptions(stateOf(), 'codex', undefined, { follow: 'F', machineLogin: 'M' }, NOW).map((o) => o.key)).toEqual([FOLLOW_KEY, MACHINE_LOGIN_KEY, 'gpt']);
    });

    it('three states compare by id, absent ≠ null', () => {
        expect(sameAccountChoice(undefined, null)).toBe(false);
        expect(sameAccountChoice({ id: 'a', label: 'x' }, { id: 'a' })).toBe(true);
        expect(sameAccountChoice(null, null)).toBe(true);
    });
});

describe('B-850e project defaults (one entry per agent, machine-scoped)', () => {
    const saved = [{ agent: 'claude', machineId: 'm1', id: 'org-a', label: 'Org A' }, { agent: 'codex', machineId: 'm1', id: null }];

    it('set / replace / remove one agent, others kept; empty → null', () => {
        expect(withProjectAccount(saved, 'claude', 'm2', { id: 'org-b', label: 'Org B' })).toEqual([
            { agent: 'codex', machineId: 'm1', id: null },
            { agent: 'claude', machineId: 'm2', id: 'org-b', label: 'Org B' },
        ]);
        expect(withProjectAccount(saved, 'claude', 'm1', null)).toContainEqual({ agent: 'claude', machineId: 'm1', id: null });
        expect(withProjectAccount(saved, 'claude', 'm1', undefined)).toEqual([{ agent: 'codex', machineId: 'm1', id: null }]);
        expect(withProjectAccount([{ agent: 'claude', machineId: 'm1', id: null }], 'claude', 'm1', undefined)).toBeNull();
        // No machine chosen: nothing to store.
        expect(withProjectAccount(null, 'claude', '', { id: 'x' })).toBeNull();
    });

    it('entry ↔ choice and change detection', () => {
        expect(entryChoice(projectAccountEntry(saved, 'claude'))).toEqual({ id: 'org-a', label: 'Org A' });
        expect(entryChoice(projectAccountEntry(saved, 'codex'))).toBeNull();
        expect(entryChoice(projectAccountEntry(saved, 'pi'))).toBeUndefined();
        expect(projectAccountsChanged(saved, [...saved].reverse())).toBe(false);
        expect(projectAccountsChanged(saved, withProjectAccount(saved, 'claude', 'm1', { id: 'org-a', label: 'renamed' }))).toBe(false);
        expect(projectAccountsChanged(saved, withProjectAccount(saved, 'claude', 'm2', { id: 'org-a' }))).toBe(true);
        expect(projectAccountsChanged(null, null)).toBe(false);
        expect(projectAccountsOf('p1', [{ id: 'p1', defaults: { agentProfiles: saved } }])).toBe(saved);
        expect(projectAccountsOf(null, [{ id: 'p1', defaults: { agentProfiles: saved } }])).toBeNull();
    });
});

describe('B-850e new session: explicit > project > machine default > machine login (source + Q3)', () => {
    const project = [{ agent: 'claude', machineId: 'm1', id: 'org-a' }];

    it('project default on its machine; source project; Q3 judged on the project account', () => {
        const r = resolveSpawnAccount(stateOf({ defaults: {} }), 'claude', undefined, NOW, { project, machineId: 'm1' });
        expect(r).toMatchObject({ kind: 'account', account: { id: 'org-a' }, fromProject: true });
        expect(spawnAccountSource(r)).toBe('project');
        const blocked = resolveSpawnAccount(stateOf(), 'claude', undefined, NOW, { project: [{ agent: 'claude', machineId: 'm1', id: 'org-b' }], machineId: 'm1' });
        expect(blocked).toMatchObject({ kind: 'blocked', reason: 'missing-secret', fromProject: true });
        // project says machine login
        expect(spawnAccountSource(resolveSpawnAccount(stateOf(), 'claude', undefined, NOW, { project: [{ agent: 'claude', machineId: 'm1', id: null }], machineId: 'm1' }))).toBe('project');
    });

    it('another machine / agent: the project default does not apply', () => {
        const r = resolveSpawnAccount(stateOf(), 'claude', undefined, NOW, { project, machineId: 'm2' });
        expect(r).toMatchObject({ kind: 'account', fromDefault: true, account: { id: 'org-a' } });
        expect(spawnAccountSource(r)).toBe('machine');
        expect(spawnAccountSource(resolveSpawnAccount(stateOf({ defaults: {} }), 'claude', undefined, NOW, { project, machineId: 'm2' }))).toBe('machine-login');
        expect(projectSpawnAccount('codex', { project, machineId: 'm1' })).toBeUndefined();
    });

    it('an explicit pick wins over the project', () => {
        const r = resolveSpawnAccount(stateOf(), 'claude', null, NOW, { project, machineId: 'm1' });
        expect(r).toEqual({ kind: 'machine', explicit: true });
        expect(spawnAccountSource(r)).toBe('explicit');
    });

    it('spawn param: the Web sends the project account (the daemon only knows its machine default)', () => {
        expect(spawnAgentProfileParam(stateOf(), 'claude', undefined, { project, machineId: 'm1' })).toEqual({ agentProfileId: 'org-a' });
        expect(spawnAgentProfileParam(stateOf(), 'claude', undefined, { project: [{ agent: 'claude', machineId: 'm1', id: null }], machineId: 'm1' })).toEqual({ agentProfileId: null });
        expect(spawnAgentProfileParam(stateOf(), 'claude', undefined, { project, machineId: 'm2' })).toEqual({});
        expect(spawnAgentProfileParam(stateOf(), 'claude', 'org-b', { project, machineId: 'm1' })).toEqual({ agentProfileId: 'org-b' });
        // An old CLI never gets one.
        expect(spawnAgentProfileParam(null, 'claude', undefined, { project, machineId: 'm1' })).toEqual({});
    });
});

describe('B-850e teams', () => {
    it('member bind target: own > team default (same agent) > machine default > machine login', () => {
        const teamDefaults = { assistant: 'claude' as const, agentProfile: { id: 'org-b' } };
        expect(memberBindTarget({ choice: { id: 'x' }, assistant: 'claude', teamDefaults })).toBe('x');
        expect(memberBindTarget({ choice: null, assistant: 'claude', teamDefaults })).toBeNull();
        expect(memberBindTarget({ choice: undefined, assistant: 'claude', teamDefaults, machineDefaults: { claude: 'org-a' } })).toBe('org-b');
        expect(memberBindTarget({ choice: undefined, assistant: 'codex', teamDefaults, machineDefaults: { codex: 'gpt' } })).toBe('gpt');
        expect(memberBindTarget({ choice: undefined, assistant: 'claude', teamDefaults: { agentProfile: null }, machineDefaults: { claude: 'org-a' } })).toBeNull();
        expect(memberBindTarget({ choice: undefined, assistant: 'claude', machineDefaults: {} })).toBeNull();
    });

    it('live switch only for an online, account-capable member not already on the target', () => {
        expect(memberNeedsLiveSwitch({ online: true, capable: true, current: 'org-a', target: 'org-b' })).toBe(true);
        expect(memberNeedsLiveSwitch({ online: true, capable: true, current: null, target: 'org-b' })).toBe(true);
        expect(memberNeedsLiveSwitch({ online: true, capable: true, current: 'org-b', target: 'org-b' })).toBe(false);
        expect(memberNeedsLiveSwitch({ online: false, capable: true, current: 'org-a', target: 'org-b' })).toBe(false);
        expect(memberNeedsLiveSwitch({ online: true, capable: false, current: undefined, target: 'org-b' })).toBe(false);
    });

    it('delegate form round-trips the choice through a hidden input', () => {
        expect(decodeAccountChoice(encodeAccountChoice(undefined))).toBeUndefined();
        expect(decodeAccountChoice(encodeAccountChoice(null))).toBeNull();
        expect(decodeAccountChoice(encodeAccountChoice({ id: 'org-a', label: 'Org A' }))).toEqual({ id: 'org-a', label: 'Org A' });
        expect(decodeAccountChoice('{"id":""}')).toBeUndefined();
        expect(decodeAccountChoice('not json')).toBeUndefined();
    });
});

describe('B-850e 「需要我决策」 refusals', () => {
    it('automation error → reason', () => {
        expect(automationRefusalReason('Account unavailable (expired): account "Org A" … Fix: sign in again')).toBe('expired');
        expect(automationRefusalReason('agent-profile-unavailable:missing-secret: x')).toBe('missing-secret');
        expect(automationRefusalReason('Account unavailable (agent-mismatch): …')).toBe('agent-mismatch');
        expect(automationRefusalReason('Account unavailable (brand-new): …')).toBe('other');
        expect(automationRefusalReason('Not executed: Account "Org B" is unavailable')).toBe('other');
        expect(automationRefusalReason(null)).toBe('other');
    });

    it('team item (server text, B-850d teamAccountItem) → facts', () => {
        const item = {
            key: 'team-account:op-1',
            title: '成员 Worker 2 的账号「Org B」缺 key / 登录凭据，这一轮没有启动 · 研发',
            bodyMd: '…\n原因：`agent-profile-unavailable:missing-secret: account "Org B" … — Not run on the machine login.`',
        };
        expect(teamAccountItemFacts(item)).toEqual({ operationId: 'op-1', reason: 'missing-secret', member: 'Worker 2', account: 'Org B', team: '研发' });
        // The op named no account: the server says 「机器默认账号」.
        expect(teamAccountItemFacts({ ...item, title: '成员 W 的账号「机器默认账号」登录已过期，这一轮没有启动 · T' })).toMatchObject({ account: null, member: 'W' });
        // A truncated title still gives the operation and the reason.
        expect(teamAccountItemFacts({ ...item, title: '成员 Worker 2 的账号「Org B」缺 key…' })).toMatchObject({ operationId: 'op-1', reason: 'missing-secret', member: null });
        expect(teamAccountItemFacts({ ...item, key: 'team-submit:x' })).toBeNull();
        expect(teamAccountItemFacts({ ...item, key: null })).toBeNull();
    });
});
