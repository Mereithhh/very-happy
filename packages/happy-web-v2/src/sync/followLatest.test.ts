import { describe, expect, it } from 'vitest';
import { CLAUDE_OPUS_55_CAPABILITY, LATEST_MODEL_MODE, type LatestModelTable } from '@slopus/happy-wire';
import {
    isFollowingLatestModel,
    migrateFollowLatestOverrides,
    modelOverrideAfterSessionPick,
    resolveDefaultModelMode,
} from './agentDefaults';
import { resolveMessageModeMeta } from './messageMeta';
import { collectRecentCatalogs, launcherMachineContext } from './launcherModels';
import { modelSupportNotice } from '@/app/modelSupportPolicy';
import { getLauncherModelModes, withLatestTableModels, getCodexModelModes } from '@/components/modelModeOptions';

// B-844: "follow latest" model defaults.

const models = (ids: string[]) => ids.map((code) => ({ code, value: code }));
const CODEX_154 = models(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']);
const CODEX_166 = models(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
const capable = { capabilities: [CLAUDE_OPUS_55_CAPABILITY] };

function session(partial: { modelMode?: string | null; flavor?: string; metadata?: Record<string, unknown> }) {
    return {
        permissionMode: null,
        modelMode: partial.modelMode ?? null,
        effortLevel: null,
        metadata: { flavor: partial.flavor ?? 'claude', ...partial.metadata },
    } as any;
}

describe('resolveDefaultModelMode with the latest sentinel', () => {
    it('claude: a capable wrapper gets claude-opus-5-5, an old one the machine default', () => {
        expect(resolveDefaultModelMode({}, 'claude', capable)).toBe('claude-opus-5-5');
        expect(resolveDefaultModelMode({}, 'claude', { capabilities: [] })).toBe('default');
        expect(resolveDefaultModelMode({}, 'claude', null)).toBe('claude-opus-5-5');
    });

    it('codex: resolves from the session catalog, then the machine Codex version', () => {
        expect(resolveDefaultModelMode({}, 'codex', { models: CODEX_166 })).toBe('gpt-6.1-sol');
        expect(resolveDefaultModelMode({}, 'codex', { models: CODEX_154 })).toBe('gpt-5.6-sol');
        expect(resolveDefaultModelMode({}, 'codex', {})).toBe('default');
        expect(resolveDefaultModelMode({}, 'codex', null, { machine: { agentVersion: '0.158.0' } })).toBe('gpt-6-sol');
    });

    it('a pinned override is returned as is and never re-resolved', () => {
        expect(resolveDefaultModelMode({ codex: { modelMode: 'gpt-5.5' } }, 'codex', { models: CODEX_166 })).toBe('gpt-5.5');
        expect(resolveDefaultModelMode({ claude: { modelMode: 'fable' } }, 'claude', capable)).toBe('fable');
    });

    it('a server table with a newer flagship is followed once the wrapper proves it', () => {
        const table: LatestModelTable = {
            version: 2,
            agents: { codex: { tier: 'sol', pattern: '^gpt-(\\d+)(?:\\.(\\d+))?-sol$', models: [{ model: 'gpt-6.2-sol', requires: { agentVersion: '0.170.0' } }] } },
        };
        expect(resolveDefaultModelMode({}, 'codex', { models: CODEX_166 }, { table })).toBe('gpt-6.1-sol');
        expect(resolveDefaultModelMode({}, 'codex', { models: [...CODEX_166, { code: 'gpt-6.2-sol', value: 'x' }] }, { table })).toBe('gpt-6.2-sol');
    });

    it('never returns the sentinel', () => {
        for (const flavor of ['claude', 'codex', 'gemini', 'acp', 'openclaw']) {
            for (const metadata of [null, {}, capable]) {
                expect(resolveDefaultModelMode({}, flavor, metadata)).not.toBe(LATEST_MODEL_MODE);
            }
        }
    });
});

describe('resolveMessageModeMeta follows latest', () => {
    it('claude sends the resolved Opus, or null on a wrapper that cannot prove one', () => {
        expect(resolveMessageModeMeta(session({ metadata: capable }), { agentDefaultOverrides: {} }).model).toBe('claude-opus-5-5');
        expect(resolveMessageModeMeta(session({}), { agentDefaultOverrides: {} }).model).toBeNull();
    });

    it('codex sends the newest sol its catalog lists; nothing before the catalog arrives', () => {
        expect(resolveMessageModeMeta(session({ flavor: 'codex', metadata: { models: CODEX_166 } }), { agentDefaultOverrides: {} }).model).toBe('gpt-6.1-sol');
        expect(resolveMessageModeMeta(session({ flavor: 'codex', metadata: { models: CODEX_154 } }), { agentDefaultOverrides: {} }).model).toBe('gpt-5.6-sol');
        expect(resolveMessageModeMeta(session({ flavor: 'codex' }), { agentDefaultOverrides: {} })).not.toHaveProperty('model');
    });

    it('an override or a session pick still wins; a stray `latest` value is resolved, never sent', () => {
        expect(resolveMessageModeMeta(session({ flavor: 'codex', metadata: { models: CODEX_166 } }), { agentDefaultOverrides: { codex: { modelMode: 'gpt-5.5' } } }).model).toBe('gpt-5.5');
        expect(resolveMessageModeMeta(session({ flavor: 'codex', modelMode: 'gpt-6-luna', metadata: { models: CODEX_166 } }), { agentDefaultOverrides: {} }).model).toBe('gpt-6-luna');
        expect(resolveMessageModeMeta(session({ flavor: 'codex', modelMode: 'latest', metadata: { models: CODEX_166 } }), { agentDefaultOverrides: { codex: { modelMode: 'latest' } } }).model).toBe('gpt-6.1-sol');
        expect(resolveMessageModeMeta(session({ flavor: 'codex', modelMode: 'latest' }), { agentDefaultOverrides: {} })).not.toHaveProperty('model');
        expect(resolveMessageModeMeta(session({ modelMode: 'latest', metadata: capable }), { agentDefaultOverrides: {} }).model).toBe('claude-opus-5-5');
    });

    it('gemini follows its catalog; pi keeps sending no model', () => {
        const gemini = session({ flavor: 'gemini', metadata: { models: models(['gemini-2.5-pro', 'gemini-3.1-pro-preview']) } });
        expect(resolveMessageModeMeta(gemini, { agentDefaultOverrides: {} }).model).toBe('gemini-3.1-pro-preview');
        expect(resolveMessageModeMeta(session({ flavor: 'acp', metadata: { models: models(['zai/glm-5.3']) } }), { agentDefaultOverrides: {} })).not.toHaveProperty('model');
    });
});

describe('session picks no longer pin the account default', () => {
    it('picking what latest resolves to clears the override; anything else is remembered', () => {
        expect(modelOverrideAfterSessionPick('claude', 'claude-opus-5-5', 'claude-opus-5-5')).toBeNull();
        expect(modelOverrideAfterSessionPick('claude', 'claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]');
        expect(modelOverrideAfterSessionPick('codex', 'gpt-5.6-sol', 'gpt-6.1-sol')).toBe('gpt-5.6-sol');
        expect(modelOverrideAfterSessionPick('codex', 'default', 'gpt-6.1-sol')).toBe('default');
        // Nothing resolvable (old wrapper): the pick is a real choice.
        expect(modelOverrideAfterSessionPick('claude', 'claude-opus-5-5', null)).toBe('claude-opus-5-5');
        // pi's code default is not latest: its picks stay remembered.
        expect(modelOverrideAfterSessionPick('acp', 'zai/glm-5.3', 'zai/glm-5.3')).toBe('zai/glm-5.3');
    });

    it('isFollowingLatestModel reflects the stored override', () => {
        expect(isFollowingLatestModel({}, 'claude')).toBe(true);
        expect(isFollowingLatestModel({ claude: { modelMode: 'claude-opus-5-5' } }, 'claude')).toBe(false);
        expect(isFollowingLatestModel({}, 'acp')).toBe(false);
    });
});

describe('migrateFollowLatestOverrides (one time)', () => {
    it('turns overrides equal to the then-latest model into follow-latest, keeps the rest', () => {
        const migrated = migrateFollowLatestOverrides({
            claude: { modelMode: 'claude-opus-5-5', permissionMode: 'plan' },
            codex: { modelMode: 'gpt-5.5' },
            gemini: { modelMode: 'gemini-3.1-pro-preview' },
        }, null, 42);
        expect(migrated).toEqual({
            agentDefaultOverrides: { claude: { permissionMode: 'plan' }, codex: { modelMode: 'gpt-5.5' } },
            modelFollowLatestMigratedAt: 42,
        });
    });

    it('stamps accounts with nothing to migrate and never runs twice', () => {
        expect(migrateFollowLatestOverrides({ claude: { modelMode: 'fable' } }, null, 7)).toEqual({ modelFollowLatestMigratedAt: 7 });
        expect(migrateFollowLatestOverrides({ claude: { modelMode: 'claude-opus-5-5' } }, 7, 8)).toBeNull();
    });
});

describe('lists without a session merge live catalogs', () => {
    const sessions = [
        { updatedAt: 1, metadata: { flavor: 'codex', machineId: 'm1', models: CODEX_154 } },
        { updatedAt: 3, metadata: { flavor: 'codex', machineId: 'm1', models: CODEX_166 } },
        { updatedAt: 2, metadata: { flavor: 'codex', machineId: 'm2', models: models(['gpt-5.5', 'gpt-x-preview']) } },
        { updatedAt: 9, metadata: { flavor: 'claude', machineId: 'm1', models: models(['opus']) } },
    ];

    it('one newest catalog per machine, filtered by agent and machine', () => {
        expect(collectRecentCatalogs(sessions as any, 'codex', 'm1').map((m) => m.models!.length)).toEqual([CODEX_166.length]);
        expect(collectRecentCatalogs(sessions as any, 'codex').map((m) => m.machineId)).toEqual(['m1', 'm2']);
    });

    it('the dialog list carries catalog-only models next to the code list', () => {
        const list = getLauncherModelModes('codex', collectRecentCatalogs(sessions as any, 'codex'), (k) => k).map((m) => m.key);
        expect(list[0]).toBe('default');
        expect(list).toContain('gpt-x-preview');
        expect(list).toContain('gpt-6.1-sol');
        expect(new Set(list).size).toBe(list.length);
    });

    it('a model only the server table knows becomes pickable', () => {
        const table: LatestModelTable = {
            version: 2,
            agents: { codex: { tier: 'sol', pattern: '^gpt-(\\d+)(?:\\.(\\d+))?-sol$', models: [{ model: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }] } },
        };
        const keys = withLatestTableModels('codex', getCodexModelModes(), table).map((m) => m.key);
        expect(keys.slice(0, 2)).toEqual(['default', 'gpt-6.2-sol']);
    });

    it('machine context reads the CLI and agent versions', () => {
        const machine = {
            metadata: { happyCliVersion: '0.2.190' },
            daemonState: { pid: 1, agentVersionEpoch: 0, agentVersions: { checkedAt: Date.now(), daemonPid: 1, agents: [{ id: 'codex', installed: '0.154.0', latest: '0.166.0', status: 'update-available' }] } },
        };
        expect(launcherMachineContext(machine as any, 'codex', null)).toEqual({ cliVersion: '0.2.190', agentVersion: '0.154.0', catalog: null });
        expect(launcherMachineContext(null, 'codex', null)).toBeNull();
    });
});

describe('B-487 notice for a session following latest', () => {
    it('a Codex whose catalog lacks the newest sol says which version brings it', () => {
        const notice = modelSupportNotice(session({ flavor: 'codex', metadata: { models: CODEX_154 } }), null, {});
        expect(notice).toMatchObject({ kind: 'codex-gpt6', model: 'gpt-6.1-sol', minVersion: '0.160.0', action: 'update' });
        expect(modelSupportNotice(session({ flavor: 'codex', metadata: { models: CODEX_166 } }), null, {})).toBeNull();
    });

    it('a pinned model keeps its own notice (not the latest one)', () => {
        const pinned = session({ flavor: 'codex', modelMode: 'gpt-6-sol', metadata: { models: CODEX_154 } });
        expect(modelSupportNotice(pinned, null, {})).toMatchObject({ kind: 'codex-gpt6', model: 'gpt-6-sol', minVersion: '0.155.0' });
        expect(modelSupportNotice(session({ flavor: 'codex', metadata: { models: CODEX_154 } }), null, { codex: { modelMode: 'gpt-5.5' } })).toBeNull();
    });

    it('an old Claude wrapper following latest still gets the Opus 5.5 notice', () => {
        expect(modelSupportNotice(session({ metadata: { capabilities: [], version: '0.2.140' } }), null, {})).toMatchObject({ kind: 'claude-opus-55', model: 'claude-opus-5-5' });
        expect(modelSupportNotice(session({ metadata: capable }), null, {})).toBeNull();
    });
});
