// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCustomModelName, rememberCustomModel } from './customModelInput';

describe('B-893: typed model names', () => {
    it('accepts provider ids as typed (trimmed), with or without [1m]', () => {
        for (const id of ['gpt-6.1-sol', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'us.anthropic.claude-opus-5-5:0', 'GLM-5.3']) {
            expect(checkCustomModelName(` ${id} `)).toEqual({ ok: true, value: id });
        }
    });
    it('refuses empty, too long, characters a resume would drop, and the picker sentinels', () => {
        expect(checkCustomModelName('   ')).toEqual({ ok: false, reason: 'empty' });
        expect(checkCustomModelName('[1m]')).toEqual({ ok: false, reason: 'empty' });
        expect(checkCustomModelName('a'.repeat(64))).toEqual({ ok: true, value: 'a'.repeat(64) });
        expect(checkCustomModelName('a'.repeat(65))).toEqual({ ok: false, reason: 'tooLong' });
        for (const id of ['gpt 6', 'llm-hub/glm-5.3', '-x', 'x;rm', 'x[1m][1m]', 'x\ny']) {
            expect(checkCustomModelName(id).ok, id).toBe(false);
        }
        expect(checkCustomModelName('latest')).toEqual({ ok: false, reason: 'reserved' });
        expect(checkCustomModelName('default')).toEqual({ ok: false, reason: 'reserved' });
    });
    it('every accepted name passes the daemon resume precheck (happy-cli resumePrecheck.ts)', () => {
        const resume = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[1m\])?$/i;
        for (const id of ['gpt-6.1-sol', 'a'.repeat(64), 'a'.repeat(64) + '[1m]', 'x:0']) {
            const result = checkCustomModelName(id);
            expect(result.ok && resume.test(result.value), id).toBe(true);
        }
    });
    it('remembers the last three, most recent first, without duplicates', () => {
        let list: string[] = [];
        for (const id of ['a', 'b', 'c', 'b', 'd']) list = rememberCustomModel(list, id);
        expect(list).toEqual(['d', 'b', 'c']);
    });
});

describe('recent typed names persist per agent in this browser', () => {
    beforeEach(() => { localStorage.clear(); vi.resetModules(); });
    it('reads back what was remembered, per agent, and survives a broken entry', async () => {
        localStorage.setItem('vh.recentCustomModels.claude', '{oops');
        const first = await import('./customModelInput');
        expect(first.recentCustomModelsStore.getState().byAgent.claude).toEqual([]);
        first.recentCustomModelsStore.getState().remember('codex', 'gpt-6.1-sol');
        first.recentCustomModelsStore.getState().remember('codex', 'gpt-6-luna');
        vi.resetModules();
        const second = await import('./customModelInput');
        expect(second.recentCustomModelsStore.getState().byAgent).toEqual({ claude: [], codex: ['gpt-6-luna', 'gpt-6.1-sol'] });
    });
});
