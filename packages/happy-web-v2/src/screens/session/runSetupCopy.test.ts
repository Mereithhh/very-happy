import { describe, expect, it } from 'vitest';
import { codexModelName, localizeModelDescriptions, localizeModelNames } from './runSetupCopy';
import { runnableFromCatalogs } from '@/sync/launcherModels';
import { readFileSync } from 'node:fs';

const t = ((key: string) => key === 'session.chat.modelPicker.aliasSuffix' ? '（别名）' : key) as never;

describe('QA26 P2-5: one way to write a model name', () => {
    it('Codex ids read GPT-<version>-<Tier>, whatever the source said', () => {
        expect(codexModelName('gpt-6.1-terra')).toBe('GPT-6.1-Terra');
        expect(codexModelName('gpt-5.5')).toBe('GPT-5.5');
        expect(codexModelName('gpt-5.1-codex-max')).toBe('GPT-5.1-Codex-Max');
        expect(codexModelName('my-proxy-model')).toBeNull();
        const out = localizeModelNames('codex', [
            { key: 'latest', name: 'f' }, { key: 'default', name: 'd' },
            { key: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' }, { key: 'gpt-6.1-sol', name: 'gpt-6.1-sol' }, { key: 'my-proxy-model', name: 'my-proxy-model' },
        ], t);
        expect(out.map((o) => o.name)).toEqual(['f', 'd', 'GPT-6.1-Terra', 'GPT-6.1-Sol', 'my-proxy-model']);
    });
    it('Claude: the alias-of-pinned entry is localized, 1M kept', () => {
        const out = localizeModelNames('claude', [
            { key: 'opus', name: 'opus (alias)' }, { key: 'opus[1m]', name: 'opus (alias, 1M context)' }, { key: 'opus[1m]', name: 'opus (alias) · 1M' }, { key: 'sonnet', name: 'Sonnet 5.5' },
        ], t);
        expect(out.map((o) => o.name)).toEqual(['opus（别名）', 'opus（别名） · 1M', 'opus（别名） · 1M', 'Sonnet 5.5']);
    });
    it('untiered Codex ids are 「旧版本」 next to a newer tiered model', () => {
        const out = localizeModelDescriptions('codex', [
            { key: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { key: 'gpt-5.5', name: 'GPT-5.5' }, { key: 'gpt-5.3-codex', name: 'GPT-5.3-Codex' }, { key: 'gpt-5.1-codex-max', name: 'x' },
        ], { keep: new Set(), translate: t });
        expect(out.slice(1).map((o) => o.description)).toEqual(Array(3).fill('session.chat.modelPicker.desc.older'));
        expect(out[0].description).toBe('session.chat.modelPicker.desc.sol');
    });
});

describe('QA26 P2-7: Settings folds what no machine runs as newest', () => {
    it('runnable keys come from the catalogs (+ pinned Opus 5.5 for Claude); none → null', () => {
        expect(runnableFromCatalogs('claude', [])).toBeNull();
        expect([...runnableFromCatalogs('claude', [{ models: [{ code: 'sonnet', value: 'Sonnet 5.5' }] } as never])!]).toEqual(['sonnet', 'claude-opus-5-5']);
        expect([...runnableFromCatalogs('codex', [{ models: [{ code: 'gpt-6.1-sol', value: 'x' }] } as never])!]).toEqual(['gpt-6.1-sol']);
    });
    it('Settings and the composer use the same names; Settings folds everything off the top list (1M twins too)', () => {
        const settings = readFileSync(new URL('../settings/SettingsRoutes.tsx', import.meta.url), 'utf8');
        const input = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');
        expect(settings).toContain('const moreKeys = new Set(modelOptions.filter((option) => !primaryKeys.has(option.key)).map((option) => option.key));');
        expect(settings).toContain('runnable: runnableFromCatalogs(agent, catalogs) });');
        expect(settings).toContain('localizeModelDescriptions(agent, localizeModelNames(agent,');
        expect(input).toContain('const baseModels = localizeModelNames(flavor,');
        expect(input).toContain("{ agent: sessionAgentLabel(normalizeAgentKey(flavor), normalizeAgentKey(flavor)), value }");
    });
});
