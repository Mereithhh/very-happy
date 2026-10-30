import { describe, expect, it } from 'vitest';
import { CLAUDE_OPUS_55_CAPABILITY, LATEST_MODEL_MODE, type LatestModelTable } from '@slopus/happy-wire';
import {
    followLatestByMachine,
    followLatestState,
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
