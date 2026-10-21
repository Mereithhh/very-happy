import { describe, expect, it } from 'vitest';
import { preferredTeamAssistant, teamHarnessChoices, teamModelChoices } from './teamHarnessModel';

const meta = (cli: Record<string, boolean>) => ({ cliAvailability: cli }) as never;
const labels = { followDefault: 'Follow the harness default', custom: 'custom', missing: 'not listed' };

describe('B-698 team harness choices', () => {
    it('lists only harnesses the machine can run (claude is bundled; pi needs an explicit true)', () => {
        expect(teamHarnessChoices(meta({ codex: false, pi: true }), 'claude').map((c) => c.value)).toEqual(['claude', 'pi-acp']);
        expect(teamHarnessChoices(meta({ codex: true }), 'claude').map((c) => c.value)).toEqual(['claude', 'codex']);
    });
    it('keeps a saved harness that is no longer available, flagged', () => {
        const choices = teamHarnessChoices(meta({ codex: false }), 'codex');
        expect(choices.find((c) => c.value === 'codex')).toEqual({ value: 'codex', label: 'Codex', available: false });
    });
    it('falls back to the first available harness when switching machines', () => {
        expect(preferredTeamAssistant(meta({ codex: false }), 'codex')).toBe('claude');
        expect(preferredTeamAssistant(meta({ codex: true }), 'codex')).toBe('codex');
    });
});

describe('B-698 team model choices', () => {
    const catalog = [{ key: 'default', name: 'default model' }, { key: 'opus', name: 'opus (alias)' }, { key: 'claude-opus-5-5', name: 'opus 5.5' }];
    it('starts with "follow default", then the catalog (minus its default), then custom models', () => {
        const { choices, savedMissing } = teamModelChoices({ catalog, custom: ['glm-5.3', 'opus'], saved: '', labels });
        expect(choices.map((c) => [c.value, c.kind])).toEqual([['', 'default'], ['opus', 'catalog'], ['claude-opus-5-5', 'catalog'], ['glm-5.3', 'custom']]);
        expect(savedMissing).toBe(false);
    });
    it('a saved model outside the list stays selectable and is flagged', () => {
        const { choices, savedMissing } = teamModelChoices({ catalog, custom: [], saved: 'old-model', labels });
        expect(savedMissing).toBe(true);
        expect(choices.at(-1)).toEqual({ value: 'old-model', label: 'old-model · not listed', kind: 'missing' });
    });
    it('a saved custom model is not flagged', () => {
        expect(teamModelChoices({ catalog, custom: ['glm-5.3'], saved: 'glm-5.3', labels }).savedMissing).toBe(false);
    });
});
