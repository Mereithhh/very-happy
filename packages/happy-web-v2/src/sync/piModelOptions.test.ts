import { describe, expect, it } from 'vitest';
import { collectPiModelOptions, withPiDefaults } from './piModelOptions';

const piSession = (updatedAt: number, codes: string[], flavor = 'acp', machineId = 'm1') => ({
    updatedAt,
    metadata: { flavor, machineId, models: codes.map((code) => ({ code, value: code.toUpperCase() })) },
});

const NOW = Date.now();
const machine = (id: string, codes: string[], extra: Record<string, unknown> = {}) => ({
    id,
    daemonState: {
        pid: 9,
        piModels: { checkedAt: NOW, daemonPid: 9, models: codes.map((code) => ({ code, value: code, thinking: false })), ...extra },
    },
});

describe('collectPiModelOptions (B-370 → B-978: one catalog per machine, like other agents)', () => {
    it("starts with 'default' and takes the newest pi session's list per machine", () => {
        const options = collectPiModelOptions([
            piSession(1, ['zai/glm-5.3', 'acme/old'], 'acp', 'm1'),
            piSession(2, ['acme/new', 'zai/glm-5.3'], 'acp', 'm1'),
            piSession(1, ['other/x'], 'acp', 'm2'),
        ]);
        expect(options.map((o) => o.key)).toEqual(['default', 'acme/new', 'zai/glm-5.3', 'other/x']);
        expect(options[1].name).toBe('ACME/NEW');
    });

    it('ignores non-pi sessions even when they publish a model list (gemini/opencode are ACP too)', () => {
        const options = collectPiModelOptions([
            piSession(5, ['gemini-2.5-pro'], 'gemini'),
            piSession(4, ['opus'], 'claude'),
            { updatedAt: 3, metadata: null },
        ]);
        expect(options.map((o) => o.key)).toEqual(['default']);
    });

    it('keeps a saved override pickable when no catalog lists it anymore', () => {
        const options = collectPiModelOptions([piSession(1, ['zai/glm-5.3'])], ['acme/gone', null, 'zai/glm-5.3']);
        expect(options.map((o) => o.key)).toEqual(['default', 'zai/glm-5.3', 'acme/gone']);
    });

    it("a machine's reported `pi --list-models` table replaces that machine's session list", () => {
        const options = collectPiModelOptions(
            [piSession(1, ['zai/glm-5.3'], 'acp', 'm1'), piSession(1, ['other/x'], 'acp', 'm2')],
            [],
            [machine('m1', ['fakehub/fake-large'])],
        );
        expect(options.map((o) => o.key)).toEqual(['default', 'fakehub/fake-large', 'other/x']);
    });

    it('a machine that never ran pi still offers its reported models', () => {
        expect(collectPiModelOptions([], [], [machine('m3', ['fakehub/fake-small'])]).map((o) => o.key)).toEqual(['default', 'fakehub/fake-small']);
    });

    it('an old daemon (no piModels) leaves only the session lists, or just default', () => {
        expect(collectPiModelOptions([], [], [{ id: 'm1', daemonState: { pid: 9 } }]).map((o) => o.key)).toEqual(['default']);
    });

    it('withPiDefaults keeps default first and dedupes across catalogs', () => {
        const rows = withPiDefaults([piSession(1, ['a/x', 'b/y']).metadata, piSession(1, ['b/y', 'c/z']).metadata]);
        expect(rows.map((o) => o.key)).toEqual(['default', 'a/x', 'b/y', 'c/z']);
    });
});

describe('B-978: a models.json fallback is partial', () => {
    it('adds the machine’s newest pi session list after the partial table', () => {
        const options = collectPiModelOptions(
            [piSession(1, ['builtin/x'], 'acp', 'm1')],
            [],
            [machine('m1', ['fakehub/fake-large'], { source: 'models-json' })],
        );
        expect(options.map((o) => o.key)).toEqual(['default', 'fakehub/fake-large', 'builtin/x']);
    });
});
