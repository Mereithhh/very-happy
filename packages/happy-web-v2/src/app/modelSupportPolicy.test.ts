import { describe, expect, it } from 'vitest';
import {
    CODEX_GPT6_MIN_VERSION,
    isModelSupportNoticeVisible,
    modelSupportHintKey,
    modelSupportNotice,
    OPUS_55_MIN_CLI_VERSION,
    wantedModel,
} from './modelSupportPolicy';

const oldClaude = (extra: Record<string, unknown> = {}) => ({
    archivedAt: null,
    modelMode: null,
    metadata: { machineId: 'm1', flavor: 'claude', version: '0.2.148', capabilities: ['claude-steer-v1'], ...extra },
});
const machineOn = (version: string, extra: Record<string, unknown> = {}) => ({
    active: true,
    daemonState: { startedWithCliVersion: version, ...extra },
});

describe('Claude Opus 5.5 on an old wrapper', () => {
    it('asks for a CLI update when the machine itself is below the first capable CLI', () => {
        const notice = modelSupportNotice(oldClaude(), machineOn('0.2.148'), undefined);
        expect(notice).toEqual({
            kind: 'claude-opus-55', model: 'claude-opus-5-5', action: 'update',
            wrapperVersion: '0.2.148', machineVersion: '0.2.148', targetVersion: OPUS_55_MIN_CLI_VERSION,
        });
    });

    it('targets the recommended version when it is newer than the floor', () => {
        const notice = modelSupportNotice(oldClaude(), machineOn('0.2.140', { cliUpdate: { recommendedVersion: '0.2.151' } }), undefined);
        expect(notice?.kind === 'claude-opus-55' && notice.targetVersion).toBe('0.2.151');
        const floor = modelSupportNotice(oldClaude(), machineOn('0.2.140', { cliUpdate: { recommendedVersion: '0.2.148' } }), undefined);
        expect(floor?.kind === 'claude-opus-55' && floor.targetVersion).toBe(OPUS_55_MIN_CLI_VERSION);
    });

    it('asks only for a restart once the machine already runs a capable CLI', () => {
        expect(modelSupportNotice(oldClaude(), machineOn('0.2.149'), undefined)?.action).toBe('restart');
    });

    it('says nothing on a capable wrapper, or when the user wants another model', () => {
        expect(modelSupportNotice(oldClaude({ capabilities: ['claude-opus-5-5-v1'] }), machineOn('0.2.149'), undefined)).toBeNull();
        expect(modelSupportNotice({ ...oldClaude(), modelMode: 'sonnet' }, machineOn('0.2.148'), undefined)).toBeNull();
        expect(modelSupportNotice(oldClaude(), machineOn('0.2.148'), { claude: { modelMode: 'default' } })).toBeNull();
    });

    it('follows an explicit pick and a synced Opus 5.5 1M default', () => {
        expect(modelSupportNotice({ ...oldClaude(), modelMode: 'claude-opus-5-5[1m]' }, machineOn('0.2.148'), undefined)?.model).toBe('claude-opus-5-5[1m]');
        expect(wantedModel(oldClaude(), { claude: { modelMode: 'claude-opus-5-5[1m]' } })).toBe('claude-opus-5-5[1m]');
    });

    it('stays silent for archived sessions, mirrors, and other agents', () => {
        expect(modelSupportNotice({ ...oldClaude(), archivedAt: 1 }, machineOn('0.2.148'), undefined)).toBeNull();
        expect(modelSupportNotice(oldClaude({ flavor: 'terminal-mirror' }), machineOn('0.2.148'), undefined)).toBeNull();
        expect(modelSupportNotice(oldClaude({ flavor: 'acp' }), machineOn('0.2.148'), undefined)).toBeNull();
        expect(modelSupportNotice(oldClaude({ flavor: 'opencode' }), machineOn('0.2.148'), undefined)).toBeNull();
    });
});

describe('Codex gpt-6-sol / gpt-6-luna missing from the catalog', () => {
    const codex = (model: string | null, models: string[]) => ({
        archivedAt: null,
        modelMode: model,
        metadata: { machineId: 'm1', flavor: 'codex', models: models.map((code) => ({ code })) },
    });
    const withCodex = (installed: string) => ({
        active: true,
        daemonState: {
            pid: 7, agentVersionEpoch: 1,
            agentVersions: { checkedAt: Date.now(), daemonPid: 7, agents: [{ id: 'codex', installed, latest: '0.156.1', status: 'update-available' }] },
        },
    });

    it('asks for a Codex update when the published catalog lacks the picked model', () => {
        expect(modelSupportNotice(codex('gpt-6-sol', ['gpt-6-astra', 'gpt-5.5']), withCodex('0.154.0'), undefined)).toEqual({
            kind: 'codex-gpt6', model: 'gpt-6-sol', action: 'update', installedVersion: '0.154.0', minVersion: CODEX_GPT6_MIN_VERSION,
        });
    });

    it('asks only for a restart when the machine already has a new enough Codex', () => {
        expect(modelSupportNotice(codex('gpt-6-luna', ['gpt-5.5']), withCodex('0.156.1'), undefined)?.action).toBe('restart');
    });

    it('treats an unknown installed version as needing the update', () => {
        const notice = modelSupportNotice(codex('gpt-6-luna', ['gpt-5.5']), { active: true, daemonState: {} }, undefined);
        expect(notice).toMatchObject({ action: 'update', installedVersion: null });
    });

    it('says nothing when the catalog has it, when no catalog was published, or for other models', () => {
        expect(modelSupportNotice(codex('gpt-6-sol', ['gpt-6-sol']), withCodex('0.156.1'), undefined)).toBeNull();
        expect(modelSupportNotice(codex('gpt-6-sol', []), withCodex('0.150.0'), undefined)).toBeNull();
        expect(modelSupportNotice(codex('gpt-5.5', ['gpt-5.5']), withCodex('0.150.0'), undefined)).toBeNull();
        expect(modelSupportNotice(codex(null, ['gpt-5.5']), withCodex('0.150.0'), { codex: { modelMode: 'gpt-6-sol' } })?.model).toBe('gpt-6-sol');
    });
});

describe('B-862: Codex notice only for the model the session really requests', () => {
    // QA35: Codex 0.154.0, follow latest, catalog tops out at gpt-5.6-sol.
    const CATALOG_154 = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map((code) => ({ code }));
    const codex154 = { active: true, daemonState: {
        pid: 7, agentVersionEpoch: 1,
        agentVersions: { checkedAt: Date.now(), daemonPid: 7, agents: [{ id: 'codex', installed: '0.154.0', latest: '0.166.0', status: 'update-available' }] },
    } };
    const codex = (metadata: Record<string, unknown>, modelMode: string | null = null) => ({
        archivedAt: null,
        modelMode,
        metadata: { machineId: 'm1', flavor: 'codex', models: CATALOG_154, ...metadata },
    });
    const llmHub = { id: 'llm-hub', label: 'LLM Hub', kind: 'codex-provider', status: 'active', model: 'gpt-5.6-sol' };
    const chatgpt = { id: 'me', label: 'ChatGPT', kind: 'codex-chatgpt', status: 'active' };

    it('follow latest + a model pinned in config.toml: no notice', () => {
        expect(wantedModel(codex({ configuredModel: 'gpt-5.6-sol' }), {})).toBe('default');
        expect(modelSupportNotice(codex({ configuredModel: 'gpt-5.6-sol' }), codex154, {})).toBeNull();
        // Nothing pinned (provider set, model left to Codex): latest sends the
        // catalog's newest, not the table's gpt-6.1-sol.
        expect(wantedModel(codex({ configuredModel: null }), {})).toBe('gpt-5.6-sol');
        expect(modelSupportNotice(codex({ configuredModel: null }), codex154, {})).toBeNull();
    });

    it('an API provider account never gets the OpenAI catalog floor, even for an explicit pick', () => {
        const bound = codex({ agentProfile: llmHub, configuredModel: 'gpt-5.6-sol', models: [{ code: 'gpt-5.6-sol' }] });
        expect(modelSupportNotice(bound, codex154, {})).toBeNull();
        expect(modelSupportNotice({ ...bound, modelMode: 'gpt-6.1-sol' }, codex154, {})).toBeNull();
        expect(modelSupportNotice({ ...bound, modelMode: 'gpt-6-sol' }, codex154, { codex: { modelMode: 'gpt-6-sol' } })).toBeNull();
    });

    it('a ChatGPT account that explicitly picks a newer model is still told to update', () => {
        expect(modelSupportNotice(codex({ agentProfile: chatgpt, configuredModel: null }, 'gpt-6.1-sol'), codex154, {})).toEqual({
            kind: 'codex-gpt6', model: 'gpt-6.1-sol', action: 'update', installedVersion: '0.154.0', minVersion: '0.160.0',
        });
        // …and the synced account default counts as explicit too.
        expect(modelSupportNotice(codex({ agentProfile: chatgpt, configuredModel: null }), codex154, { codex: { modelMode: 'gpt-6-sol' } }))
            .toMatchObject({ model: 'gpt-6-sol', minVersion: CODEX_GPT6_MIN_VERSION });
    });

    it('machine login following latest: no notice; an explicit pick still gets one', () => {
        const local = codex({ agentProfile: null, configuredModel: null });
        expect(modelSupportNotice(local, codex154, {})).toBeNull();
        expect(modelSupportNotice(local, codex154, { codex: { modelMode: 'latest' } })).toBeNull();
        expect(modelSupportNotice({ ...local, modelMode: 'gpt-6.1-sol' }, codex154, {})).toMatchObject({ model: 'gpt-6.1-sol', action: 'update' });
    });
});

it('remembers a dismissal per session, model and version', () => {
    const notice = modelSupportNotice(oldClaude(), machineOn('0.2.148'), undefined)!;
    const key = modelSupportHintKey('s1', notice);
    expect(key).toBe('model-support:s1:claude-opus-55:claude-opus-5-5:0.2.148');
    expect(isModelSupportNoticeVisible(key, {})).toBe(true);
    expect(isModelSupportNoticeVisible(key, { [key]: 1 })).toBe(false);
});
