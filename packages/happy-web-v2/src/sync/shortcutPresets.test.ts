import { describe, it, expect } from 'vitest';
import { migrateTerminalCommands, presetRuns, type PromptPreset } from './shortcutPresets';

let seq = 0;
const genId = () => `gen-${++seq}`;

describe('presetRuns', () => {
    it('only run === true executes', () => {
        expect(presetRuns({ run: true })).toBe(true);
        expect(presetRuns({ run: false })).toBe(false);
        expect(presetRuns({})).toBe(false);
        expect(presetRuns({ run: undefined })).toBe(false);
    });
});

describe('migrateTerminalCommands', () => {
    it('returns null when there is nothing to migrate', () => {
        expect(migrateTerminalCommands([], [], genId)).toBeNull();
        expect(migrateTerminalCommands([{ id: 'p1', title: 't', text: 'x' }], [], genId)).toBeNull();
        expect(migrateTerminalCommands([], null, genId)).toBeNull();
        expect(migrateTerminalCommands(undefined, undefined, genId)).toBeNull();
    });

    it('converts commands into INSERT-ONLY presets appended after existing entries', () => {
        const presets: PromptPreset[] = [{ id: 'p1', title: 'hello', text: 'say hi' }];
        const out = migrateTerminalCommands(presets, [
            { id: 'c1', title: 'build', command: 'pnpm build' },
            { id: 'c2', title: 'test', command: 'pnpm test' },
        ], genId)!;
        expect(out.terminalCommands).toEqual([]);
        expect(out.promptPresets[0]).toEqual(presets[0]); // existing untouched, order kept
        // No run flag: the legacy menu pasted without Enter, and migration
        // must not arm auto-execute behind the user's back.
        expect(out.promptPresets.slice(1)).toEqual([
            { id: expect.stringMatching(/^gen-/), title: 'build', text: 'pnpm build' },
            { id: expect.stringMatching(/^gen-/), title: 'test', text: 'pnpm test' },
        ]);
        expect(out.promptPresets.every((p) => !presetRuns(p))).toBe(true);
        // fresh ids — never reuses the legacy command id
        expect(out.promptPresets.map((p) => p.id)).not.toContain('c1');
    });

    it('does not mutate its inputs', () => {
        const presets: PromptPreset[] = [{ id: 'p1', title: 'a', text: 'a' }];
        const commands = [{ id: 'c1', title: 'b', command: 'b' }];
        migrateTerminalCommands(presets, commands, genId);
        expect(presets).toHaveLength(1);
        expect(commands).toHaveLength(1);
    });

    it('skips commands whose text already exists (idempotence / concurrent devices)', () => {
        const migrated: PromptPreset[] = [
            { id: 'p1', title: 'build', text: 'pnpm build' },
        ];
        // Same command list arriving again (other device migrated first, LWW
        // merged, this device still holds the stale non-empty legacy list).
        const out = migrateTerminalCommands(migrated, [
            { id: 'c1', title: 'build', command: 'pnpm build' },
        ], genId)!;
        // Still clears the legacy field, but adds nothing.
        expect(out.promptPresets).toEqual(migrated);
        expect(out.terminalCommands).toEqual([]);
    });

    it('a same-text preset blocks migration whatever its run flag — identity is the TEXT', () => {
        // The whole point of the merge: one text, one entry. A run-preset the
        // user armed by hand must not be duplicated by a plain copy either.
        const armed: PromptPreset[] = [{ id: 'p1', title: 'build', text: 'pnpm build', run: true }];
        const out = migrateTerminalCommands(armed, [
            { id: 'c1', title: 'build', command: 'pnpm build' },
        ], genId)!;
        expect(out.promptPresets).toEqual(armed);
        expect(out.terminalCommands).toEqual([]);
    });

    it('dedupes identical commands within the batch itself', () => {
        const out = migrateTerminalCommands([], [
            { id: 'c1', title: 'a', command: 'ls' },
            { id: 'c2', title: 'b', command: 'ls' },
        ], genId)!;
        expect(out.promptPresets).toHaveLength(1);
        expect(out.promptPresets[0].title).toBe('a');
    });

    it('drops whitespace-only commands but still clears the legacy list', () => {
        const out = migrateTerminalCommands([], [
            { id: 'c1', title: 'junk', command: '   \n' },
        ], genId)!;
        expect(out.promptPresets).toEqual([]);
        expect(out.terminalCommands).toEqual([]);
    });

    it('running the migration output through again is a no-op (terminalCommands cleared)', () => {
        const first = migrateTerminalCommands([], [
            { id: 'c1', title: 'build', command: 'pnpm build' },
        ], genId)!;
        expect(migrateTerminalCommands(first.promptPresets, first.terminalCommands, genId)).toBeNull();
    });
});
