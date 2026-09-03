import { describe, it, expect } from 'vitest';
import {
    isStartupSelectionId,
    normalizeStartupCommand,
    removeStartupPreset,
    resolveStartupCommand,
    startupChoices,
    STARTUP_DEFAULT_ID,
    STARTUP_NONE_ID,
    STARTUP_PRESET_CAP,
    selectionForLaunch,
    touchStartupPreset,
    type StartupPreset,
} from './terminalStartup';

const ids = () => {
    let n = 0;
    return () => `id${++n}`;
};

describe('touchStartupPreset', () => {
    it('records a new command at the front', () => {
        const res = touchStartupPreset([], '  claude  ', ids());
        expect(res).toEqual({ list: [{ id: 'id1', command: 'claude' }], id: 'id1' });
    });

    it('moves an existing command to the front and KEEPS its id', () => {
        const list: StartupPreset[] = [{ id: 'a', command: 'claude' }, { id: 'b', command: 'pi' }];
        const res = touchStartupPreset(list, 'pi', ids())!;
        expect(res.id).toBe('b');
        expect(res.list.map((p) => p.command)).toEqual(['pi', 'claude']);
        expect(res.list).toHaveLength(2); // moved, not duplicated
    });

    it('drops the oldest entry past the cap', () => {
        let list: StartupPreset[] = [];
        const newId = ids();
        for (let i = 0; i < STARTUP_PRESET_CAP + 3; i += 1) {
            list = touchStartupPreset(list, `cmd${i}`, newId)!.list;
        }
        expect(list).toHaveLength(STARTUP_PRESET_CAP);
        expect(list[0].command).toBe(`cmd${STARTUP_PRESET_CAP + 2}`);
        expect(list.some((p) => p.command === 'cmd0')).toBe(false);
    });

    it('records nothing for an empty command', () => {
        expect(touchStartupPreset([], '   ', ids())).toBeNull();
    });
});

describe('removeStartupPreset', () => {
    it('drops just that entry', () => {
        const list: StartupPreset[] = [{ id: 'a', command: 'claude' }, { id: 'b', command: 'pi' }];
        expect(removeStartupPreset(list, 'a')).toEqual([{ id: 'b', command: 'pi' }]);
    });
});

describe('resolveStartupCommand', () => {
    const presets: StartupPreset[] = [{ id: 'a', command: 'pi' }];

    it('uses the global command for the default selection and for none at all', () => {
        expect(resolveStartupCommand({ presets, selectionId: STARTUP_DEFAULT_ID, globalCommand: 'claude' })).toBe('claude');
        expect(resolveStartupCommand({ presets, selectionId: undefined, globalCommand: 'claude' })).toBe('claude');
    });

    it('runs NOTHING for the explicit none, even with a global command set', () => {
        expect(resolveStartupCommand({ presets, selectionId: STARTUP_NONE_ID, globalCommand: 'claude' })).toBeUndefined();
    });

    it('runs the selected preset', () => {
        expect(resolveStartupCommand({ presets, selectionId: 'a', globalCommand: 'claude' })).toBe('pi');
    });

    it('falls back to the default for an id that is not in the user own list', () => {
        // Deleted on another device, or a hand-written URL: the resolution can
        // only ever yield something the user saved, never the id text itself.
        expect(resolveStartupCommand({ presets, selectionId: 'rm -rf /', globalCommand: 'claude' })).toBe('claude');
        expect(resolveStartupCommand({ presets: undefined, selectionId: 'gone', globalCommand: 'claude' })).toBe('claude');
    });

    it('treats an empty global command as disabled', () => {
        expect(resolveStartupCommand({ presets, selectionId: STARTUP_DEFAULT_ID, globalCommand: '  ' })).toBeUndefined();
        expect(resolveStartupCommand({ presets, selectionId: undefined, globalCommand: undefined })).toBeUndefined();
    });
});

describe('isStartupSelectionId', () => {
    it('accepts generated ids and the reserved words, rejects command-shaped text', () => {
        expect(isStartupSelectionId('a1b2c3d4e5f6')).toBe(true);
        expect(isStartupSelectionId(STARTUP_NONE_ID)).toBe(true);
        expect(isStartupSelectionId('claude --dangerously-skip-permissions')).toBe(false);
        expect(isStartupSelectionId('')).toBe(false);
        expect(isStartupSelectionId(undefined)).toBe(false);
    });
});

describe('startupChoices', () => {
    it('is default first, then the MRU, then none', () => {
        const out = startupChoices([{ id: 'a', command: 'pi' }], 'claude');
        expect(out.map((c) => c.id)).toEqual([STARTUP_DEFAULT_ID, 'a', STARTUP_NONE_ID]);
        expect(out.map((c) => c.removable)).toEqual([false, true, false]);
    });

    it('does not render the global command twice when the MRU also holds it', () => {
        const out = startupChoices([{ id: 'a', command: 'claude' }, { id: 'b', command: 'pi' }], 'claude');
        expect(out.map((c) => c.command)).toEqual(['claude', 'pi', '']);
    });

    it('omits the default chip when no global command is set', () => {
        expect(startupChoices([], '').map((c) => c.id)).toEqual([STARTUP_NONE_ID]);
    });
});

describe('normalizeStartupCommand', () => {
    it('trims the ends but leaves the line alone', () => {
        expect(normalizeStartupCommand('  claude --model opus  ')).toBe('claude --model opus');
    });
});

describe('selectionForLaunch', () => {
    const presets: StartupPreset[] = [{ id: 'a', command: 'pi' }];

    it('reuses the default chip id and stores nothing when the text is the global command', () => {
        expect(selectionForLaunch(presets, 'claude', 'claude', ids())).toEqual({ selectionId: STARTUP_DEFAULT_ID });
    });

    it('reuses an existing MRU chip without rewriting the list', () => {
        expect(selectionForLaunch(presets, 'claude', '  pi ', ids())).toEqual({ selectionId: 'a' });
    });

    it('records a hand-typed command so it becomes a chip next time', () => {
        const res = selectionForLaunch(presets, 'claude', 'pi --repl', ids());
        expect(res.selectionId).toBe('id1');
        expect(res.nextPresets!.map((p) => p.command)).toEqual(['pi --repl', 'pi']);
    });

    it('empty text is the explicit no-command, and never grows the MRU', () => {
        expect(selectionForLaunch(presets, 'claude', '   ', ids())).toEqual({ selectionId: STARTUP_NONE_ID });
    });

    it('round-trips: what it selects is what resolveStartupCommand runs', () => {
        const res = selectionForLaunch(presets, 'claude', 'pi --repl', ids());
        expect(resolveStartupCommand({
            presets: res.nextPresets ?? presets,
            selectionId: res.selectionId,
            globalCommand: 'claude',
        })).toBe('pi --repl');
    });
});
