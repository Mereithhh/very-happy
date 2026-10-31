import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLAUDE_OPUS_55_CAPABILITY, LATEST_MODEL_MODE, type LatestModelTable } from '@slopus/happy-wire';
import {
    claudeMachineConfigEntry,
    customModelsBesideFollow,
    followEntryModel,
    followLatestByMachine,
    followLatestState,
    launcherReportsRunFacts,
    RUN_FACTS_CLI_VERSION,
    modelPickToStore,
    summarizeFollowLatest,
    withFollowLatestOption,
    type FollowLatestSessionSource,
} from './followLatestDisplay';
import { resolveLatestForAgent } from './agentDefaults';
import { resolveMessageModeMeta } from './messageMeta';
import { getAvailableModels, getClaudeModelModes, getCodexModelModes } from '@/components/modelModeOptions';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';

// B-844b: QA22 P2-1..P2-4 — how "follow latest" is shown.

const models = (ids: string[]) => ids.map((code) => ({ code, value: code }));
const CODEX_166 = models(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5']);
const FOLLOW = { name: 'Follow latest (gpt-6.1-sol)', description: null };
const MACHINE_DEFAULT = { name: 'Machine default', description: null };
const t = (key: string) => key;

describe('withFollowLatestOption (P2-4: one entry, no internal key)', () => {
    const codexSession = { flavor: 'codex', models: CODEX_166, defaultModelCode: 'gpt-6.1-sol', configuredModel: null } as any;

    it('codex: the machine default and the latest model collapse into the follow entry', () => {
        const options = withFollowLatestOption(getAvailableModels('codex', codexSession, t), {
            flavor: 'codex', follow: FOLLOW, latestModel: 'gpt-6.1-sol', selectedKey: LATEST_MODEL_MODE, machineDefault: MACHINE_DEFAULT,
        });
        expect(options[0]).toEqual({ key: LATEST_MODEL_MODE, ...FOLLOW });
        expect(options.map((o) => o.key)).not.toContain('default');
        expect(options.map((o) => o.key)).not.toContain('gpt-6.1-sol');
        expect(options.filter((o) => /6\.1-sol/i.test(o.name))).toHaveLength(1);
        expect(options.some((o) => o.name === 'default model')).toBe(false);
    });

    it('claude keeps the machine default (follows /model) under a real name, without a model name', () => {
        const options = withFollowLatestOption(getClaudeModelModes(), {
            flavor: 'claude', follow: FOLLOW, latestModel: 'claude-opus-5-5', selectedKey: LATEST_MODEL_MODE, machineDefault: MACHINE_DEFAULT,
        });
        expect(options.find((o) => o.key === 'default')?.name).toBe('Machine default');
        expect(options.map((o) => o.key)).not.toContain('claude-opus-5-5');
        expect(options.filter((o) => o.key === LATEST_MODEL_MODE)).toHaveLength(1);
    });

    it('an explicit pick of the latest model or of the machine default stays visible and selected', () => {
        const pinned = withFollowLatestOption(getCodexModelModes(), {
            flavor: 'codex', follow: FOLLOW, latestModel: 'gpt-6.1-sol', selectedKey: 'gpt-6.1-sol', machineDefault: MACHINE_DEFAULT,
        });
        expect(pinned.map((o) => o.key)).toContain('gpt-6.1-sol');
        const machineDefault = withFollowLatestOption(getCodexModelModes(), {
            flavor: 'codex', follow: FOLLOW, latestModel: 'gpt-6.1-sol', selectedKey: 'default', machineDefault: MACHINE_DEFAULT,
        });
        expect(machineDefault.find((o) => o.key === 'default')?.name).toBe('Machine default');
    });

    it('QA23 P2-3: on a machine-config pin the pinned model collapses into the follow entry; the tier latest stays listed', () => {
        const pinnedMachine = { flavor: 'codex', models: CODEX_166, defaultModelCode: 'gpt-5.6-sol', configuredModel: 'gpt-5.6-sol' } as any;
        const state = followLatestState({ model: 'gpt-6.1-sol', label: null, configured: 'gpt-5.6-sol' } as any, true);
        expect(followEntryModel(state)).toBe('gpt-5.6-sol');
        const options = withFollowLatestOption(getAvailableModels('codex', pinnedMachine, t), {
            flavor: 'codex', follow: { name: 'Follow machine config (gpt-5.6-sol)', description: null },
            latestModel: followEntryModel(state), selectedKey: LATEST_MODEL_MODE, machineDefault: MACHINE_DEFAULT,
        });
        expect(options.map((o) => o.key)).not.toContain('gpt-5.6-sol');
        expect(options.map((o) => o.key)).toContain('gpt-6.1-sol');
        expect(followEntryModel(followLatestState({ model: 'gpt-6.1-sol', label: null, configured: null } as any, true))).toBe('gpt-6.1-sol');
        expect(followEntryModel({ kind: 'machineDefault' })).toBeNull();
    });

    it('QA23 P2-3: the config model among custom picker models is not listed beside the follow entry unless pinned', () => {
        expect(customModelsBesideFollow(['gpt-5.6-sol', 'my-model'], 'gpt-5.6-sol', LATEST_MODEL_MODE)).toEqual(['my-model']);
        expect(customModelsBesideFollow(['gpt-5.6-sol', 'my-model'], 'gpt-5.6-sol', 'gpt-5.6-sol')).toEqual(['gpt-5.6-sol', 'my-model']);
        expect(customModelsBesideFollow(['gpt-5.6-sol'], null, LATEST_MODEL_MODE)).toEqual(['gpt-5.6-sol']);
    });

    it('AgentInput dedups the model the follow entry runs', () => {
        const source = readFileSync(new URL('../screens/session/AgentInput.tsx', import.meta.url), 'utf8');
        expect(source).toContain('latestModel: followEntryModel(followState),');
        expect(source).toContain('offersFollowLatest ? customModelsBesideFollow(customModels, followEntryModel(followState), followingLatest ? LATEST_MODEL_MODE : modelKey) : customModels,');
    });

    it('picking the follow entry stores no explicit model', () => {
        expect(modelPickToStore(LATEST_MODEL_MODE)).toBeNull();
        expect(modelPickToStore('gpt-6-astra')).toBe('gpt-6-astra');
    });

    it('no user-facing string is the internal "default model" key', () => {
        for (const text of [en.settingsAgents.machineDefault, zhHans.settingsAgents.machineDefault, en.session.chat.machineDefaultModel, zhHans.session.chat.machineDefaultModel]) {
            expect(text).not.toMatch(/default model/);
        }
        expect(zhHans.settingsAgents.newSessionsFooter).not.toMatch(/default model/);
        expect(en.settingsAgents.newSessionsFooter).not.toMatch(/default model/);
    });
});

describe('followLatestState (P2-1: old CLI shown as it runs)', () => {
    it('a codex wrapper that does not report configuredModel runs the machine default', () => {
        const old = resolveLatestForAgent(null, 'codex', { models: CODEX_166 });
        expect(followLatestState(old, true)).toEqual({ kind: 'machineDefault' });
    });

    it('a machine config pin wins; a capable wrapper runs the latest', () => {
        expect(followLatestState(resolveLatestForAgent(null, 'codex', { models: CODEX_166, configuredModel: 'gpt-5.6-sol' }), true))
            .toEqual({ kind: 'machineConfig', model: 'gpt-5.6-sol' });
        expect(followLatestState(resolveLatestForAgent(null, 'codex', { models: CODEX_166, configuredModel: null }), true))
            .toMatchObject({ kind: 'latest', model: 'gpt-6.1-sol' });
    });
});

const FAKE_TABLE: LatestModelTable = {
    version: 2,
    agents: {
        claude: {
            tier: 'opus',
            pattern: '^claude-opus-(\\d+)(?:-(\\d{1,2}))?$',
            models: [
                { model: 'claude-opus-9-9', label: 'Opus 9.9 FAKE', requires: { capability: 'claude-opus-9-9-v1' } },
                { model: 'claude-opus-5-5', label: 'Opus 5.5', requires: { capability: CLAUDE_OPUS_55_CAPABILITY } },
            ],
        },
    },
};

const MACHINES = [{ id: 'm-a', label: 'alpha' }, { id: 'm-b', label: 'beta' }];

function src(machineId: string, createdAt: number, metadata: Record<string, unknown>): FollowLatestSessionSource {
    return { createdAt, updatedAt: createdAt, metadata: { machineId, ...metadata } as any };
}

describe('followLatestByMachine (P2-2: same resolution as sends, P2-3: per machine)', () => {
    it('shows what a send from that machine resolves to, not the table head', () => {
        const metadata = { flavor: 'claude', capabilities: [CLAUDE_OPUS_55_CAPABILITY] };
        const [entry] = followLatestByMachine(FAKE_TABLE, 'claude', [src('m-a', 1, metadata)], MACHINES);
        const sent = resolveMessageModeMeta({ permissionMode: null, modelMode: null, effortLevel: null, metadata: { machineId: 'm-a', ...metadata } } as any, { agentDefaultOverrides: {} }, FAKE_TABLE).model;
        expect(entry.state).toMatchObject({ kind: 'latest', model: 'claude-opus-5-5' });
        expect(sent).toBe('claude-opus-5-5');
    });

    it('two machines keep separate, stable values whichever started the newest session', () => {
        const pinned = { flavor: 'codex', models: CODEX_166, configuredModel: 'gpt-5.6-sol' };
        const unpinned = { flavor: 'codex', models: CODEX_166, configuredModel: null };
        const first = followLatestByMachine(null, 'codex', [src('m-a', 1, pinned), src('m-b', 2, unpinned)], MACHINES);
        const second = followLatestByMachine(null, 'codex', [src('m-a', 3, pinned), src('m-b', 2, unpinned)], MACHINES);
        expect(second).toEqual(first);
        expect(first.map((entry) => [entry.label, entry.state.kind])).toEqual([['alpha', 'machineConfig'], ['beta', 'latest']]);
        expect(summarizeFollowLatest(first)).toEqual({ kind: 'varies' });
    });

    it("a machine's newest session decides for that machine only", () => {
        const old = { flavor: 'codex', models: CODEX_166 };
        const fresh = { flavor: 'codex', models: CODEX_166, configuredModel: null };
        const entries = followLatestByMachine(null, 'codex', [src('m-a', 1, old), src('m-a', 5, fresh), src('m-b', 2, old)], MACHINES);
        expect(entries.map((entry) => entry.state.kind)).toEqual(['latest', 'machineDefault']);
    });

    it('agreeing machines summarize to one value; none = depends on the machine', () => {
        const unpinned = { flavor: 'codex', models: CODEX_166, configuredModel: null };
        const entries = followLatestByMachine(null, 'codex', [src('m-a', 1, unpinned), src('m-b', 2, unpinned)], MACHINES);
        expect(summarizeFollowLatest(entries)).toMatchObject({ kind: 'latest', model: 'gpt-6.1-sol' });
        expect(summarizeFollowLatest(followLatestByMachine(null, 'codex', [], MACHINES))).toEqual({ kind: 'dependsOnMachine' });
        expect(followLatestByMachine(null, 'codex', [src('gone', 1, unpinned)], MACHINES)).toEqual([]);
    });
});

describe('follow entry descriptions say what really happens (B-844c, QA22c P2-2/P2-3)', () => {
    it('old CLI: no promise of switching before an upgrade; Claude: no machine-config clause', async () => {
        const { followLatestDescriptionKey } = await import('./followLatestDisplay');
        expect(followLatestDescriptionKey({ kind: 'machineDefault' }, false)).toBe('session.chat.modelLatestDescriptionUpgradeCli');
        expect(followLatestDescriptionKey({ kind: 'machineDefault' }, true)).toBe('session.chat.modelLatestDescriptionUpgradeCli');
        expect(followLatestDescriptionKey({ kind: 'latest', model: 'claude-opus-5-5' } as any, true)).toBe('session.chat.modelLatestDescriptionClaude');
        expect(followLatestDescriptionKey({ kind: 'dependsOnMachine' }, true)).toBe('session.chat.modelLatestDescriptionClaude');
        expect(followLatestDescriptionKey({ kind: 'machineConfig', model: 'gpt-5.6-sol' } as any, false)).toBe('session.chat.modelLatestDescription');
    });

    it('the picker and Settings use the same wording for the machine-default entry and the follow subtitle', async () => {
        const { readFileSync } = await import('node:fs');
        const input = readFileSync(new URL('../screens/session/AgentInput.tsx', import.meta.url), 'utf8');
        const settings = readFileSync(new URL('../screens/settings/SettingsRoutes.tsx', import.meta.url), 'utf8');
        expect(input).toContain("description: t(followLatestDescriptionKey(followState, normalizeAgentKey(flavor) === 'claude'))");
        expect(settings).toContain("? { ...option, name: t('settingsAgents.machineDefault'), description: t(agent === 'claude' ? 'session.chat.machineDefaultModelDescription' : 'session.chat.machineDefaultModelDescriptionOther') }");
        expect(input).toContain("description: t(normalizeAgentKey(flavor) === 'claude' ? 'session.chat.machineDefaultModelDescription' : 'session.chat.machineDefaultModelDescriptionOther') }");
        expect(settings).toContain("detail={o.key === 'default' ? undefined : o.key}");
        expect(settings).toContain("t(followLatest.claude ? 'settingsAgents.followLatestByMachineClaude' : 'settingsAgents.followLatestByMachine'");
        expect(settings).toContain("machines: perMachine, claude: agent === 'claude' }");
    });
});

describe('B-849a: a draft says when the machine cannot report what follow-latest runs', () => {
    const resolution = { model: 'gpt-5.6-sol', newest: 'gpt-6.1-sol', label: 'gpt-5.6-sol', limited: true, configured: null };
    it('evidence first: a catalog without configuredModel means an old wrapper', () => {
        expect(launcherReportsRunFacts('codex', { cliVersion: '0.2.190', catalog: [{ code: 'gpt-5.6-sol' }], configuredModel: undefined })).toBe(false);
        expect(launcherReportsRunFacts('codex', { cliVersion: '0.2.187', catalog: [{ code: 'gpt-5.6-sol' }], configuredModel: null })).toBe(true);
    });
    it('no session on the machine: the daemon CLI version decides (0.2.188 first reports it)', () => {
        expect(launcherReportsRunFacts('codex', { cliVersion: '0.2.187' })).toBe(false);
        expect(launcherReportsRunFacts('gemini', { cliVersion: '0.2.187' })).toBe(false);
        expect(launcherReportsRunFacts('codex', { cliVersion: RUN_FACTS_CLI_VERSION })).toBe(true);
        expect(launcherReportsRunFacts('codex', { cliVersion: '0.2.190-dev' })).toBe(true);
        expect(launcherReportsRunFacts('codex', { cliVersion: null })).toBe(true);
        // Claude needs no machine-config fact (its latest is capability-gated).
        expect(launcherReportsRunFacts('claude', { cliVersion: '0.2.100' })).toBe(true);
        expect(launcherReportsRunFacts('codex', null)).toBe(true);
    });
    it('an unknown machine is shown as unknown, never as the table pick', () => {
        expect(followLatestState(resolution, false, { runFactsUnknown: true })).toEqual({ kind: 'machineDefault' });
        expect(followLatestState(resolution, false)).toEqual({ kind: 'latest', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' });
    });
    it('copy: one name per default, always with the model; old CLI says unknown', () => {
        expect(en.session.chat.followLatestOption({ model: 'Opus 5.5' })).toBe('Latest · Opus 5.5');
        expect(zhHans.session.chat.followLatestOption({ model: 'Opus 5.5' })).toBe('跟随最新 · Opus 5.5');
        expect(zhHans.session.chat.followMachineConfig({ model: 'gpt-5.6-sol' })).toBe('本机配置 · gpt-5.6-sol');
        expect(zhHans.session.chat.machineConfigModel({ model: 'Opus 5.5' })).toBe('本机配置 · Opus 5.5');
        expect(zhHans.session.chat.followLatestUpgradeCli).toBe('实际模型未知 · 升级 CLI');
        expect(zhHans.settingsAgents.followMachineConfigValue({ model: 'x' })).toBe('本机配置 · x');
        expect(zhHans.settingsAgents.machineDefault).toBe('本机配置');
        expect(zhHans.session.chat.effortAuto({ level: '高' })).toBe('自动（高）');
    });
});

describe('B-849a2 (QA26 P1): Claude 「本机配置」 names only what is known to run', () => {
    it('a draft names no model — the catalog `default` entry is not what settings.json runs', () => {
        expect(claudeMachineConfigEntry({ inSession: false, selectedKey: 'default', running: null })).toEqual({ model: null, selectable: true });
        expect(claudeMachineConfigEntry({ inSession: false, selectedKey: undefined })).toEqual({ model: null, selectable: true });
    });
    it('a session on it names the model it really runs, 1M included', () => {
        expect(claudeMachineConfigEntry({ inSession: true, selectedKey: 'default', running: 'claude-opus-5-5[1m]' }))
            .toEqual({ model: 'claude-opus-5-5[1m]', selectable: true });
        expect(claudeMachineConfigEntry({ inSession: true, selectedKey: 'default', running: null })).toEqual({ model: null, selectable: true });
    });
    it('mid-session from another model it is not pickable and names nothing (no model sent keeps the current one)', () => {
        expect(claudeMachineConfigEntry({ inSession: true, selectedKey: 'claude-opus-5', running: 'claude-opus-5' })).toEqual({ model: null, selectable: false });
        expect(claudeMachineConfigEntry({ inSession: true, selectedKey: null, running: 'claude-opus-5-5' })).toEqual({ model: null, selectable: false });
    });
    it('a reported settings model (PR-B configuredModel) is named', () => {
        expect(claudeMachineConfigEntry({ inSession: false, selectedKey: 'default', configuredModel: 'opus[1m]' }).model).toBe('opus[1m]');
        expect(claudeMachineConfigEntry({ inSession: true, selectedKey: 'opus', configuredModel: 'opus[1m]' })).toEqual({ model: 'opus[1m]', selectable: false });
    });
    it('withFollowLatestOption carries the disabled flag onto Claude\'s machine entry', () => {
        const out = withFollowLatestOption([{ key: 'default', name: 'x' }, { key: 'opus', name: 'Opus 5.5' }], {
            flavor: 'claude', follow: { name: 'f', description: null }, latestModel: null, selectedKey: 'opus',
            machineDefault: { name: '本机配置', description: 'd', disabled: true },
        });
        expect(out.find((o) => o.key === 'default')).toEqual({ key: 'default', name: '本机配置', description: 'd', disabled: true });
        const on = withFollowLatestOption([{ key: 'default', name: 'x' }], {
            flavor: 'claude', follow: { name: 'f', description: null }, latestModel: null, selectedKey: 'default',
            machineDefault: { name: '本机配置', description: 'd' },
        });
        expect(on.find((o) => o.key === 'default')).not.toHaveProperty('disabled');
    });
    it('copy says where Claude takes it from, and why mid-session is new-session-only', () => {
        expect(zhHans.session.chat.machineDefaultModelDescription).toBe('不指定模型，按这台机器 Claude 自己的设置（settings.json / /model）');
        expect(zhHans.session.chat.machineDefaultModelMidSession).toBe('仅新建会话可选：会话中途切过来，Claude 会沿用当前模型');
        expect(en.session.chat.machineDefaultModelDescription).toContain('settings.json / /model');
    });
    it('AgentInput wires it: Claude never takes the catalog `default` entry as its machine model', () => {
        const input = readFileSync(new URL('../screens/session/AgentInput.tsx', import.meta.url), 'utf8');
        expect(input).not.toContain("? resolvedModelOf('default')");
        expect(input).toContain('claudeMachineConfigEntry({ inSession: !!session, selectedKey: explicitModelMode,');
        expect(input).toContain("? { name: machineConfigName, description: t('session.chat.machineDefaultModelMidSession'), disabled: true }");
    });
});

describe('QA26 P2-4: 1M on the followed model still checks a row', () => {
    it('keeps the base row when its [1m] twin is the selection', () => {
        const base = [{ key: 'default', name: 'd' }, { key: 'claude-opus-5-5', name: 'Opus 5.5' }, { key: 'sonnet', name: 'Sonnet 5.5' }];
        const pick = (selectedKey: string) => withFollowLatestOption(base, {
            flavor: 'claude', follow: { name: 'f', description: null }, latestModel: 'claude-opus-5-5', selectedKey,
            machineDefault: { name: 'm', description: null },
        }).map((o) => o.key);
        expect(pick('claude-opus-5-5[1m]')).toContain('claude-opus-5-5');
        expect(pick(LATEST_MODEL_MODE)).not.toContain('claude-opus-5-5');
    });
});
