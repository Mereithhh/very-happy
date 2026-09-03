/**
 * B-334 source assertions for the dialog wiring. The dialog itself needs a
 * hydrated store, a machine and an fs probe to render, so these pin the four
 * links that make the feature work end to end; the decisions they call are
 * unit-tested in utils/terminalStartup.test.ts and utils/terminalCwd.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./NewTerminalModal.tsx', import.meta.url), 'utf8');

describe('new-terminal dialog launch wiring', () => {
  it('sends the startup selection with the create', () => {
    expect(src).toContain('{ cwd, startupSelectionId: resolveStartupSelection() }');
  });

  it('feeds the recents MRU after a successful create, with the canonical cwd', () => {
    // `cwd` (fs-list canonicalized), not the typed text: a '~' path would
    // otherwise come back as a chip the daemon cannot cd into.
    expect(src).toContain('recordRecentMachinePath(machineId, cwd);');
    const create = src.indexOf('if (!createTerminalAt(navigate, machineId, { cwd');
    expect(create).toBeGreaterThan(-1);
    expect(src.indexOf('recordRecentMachinePath(machineId, cwd);')).toBeGreaterThan(create);
  });

  it('renders curated presets and recents from one merged list', () => {
    expect(src).toContain('mergeDirectoryChoices(list, recents, machineId)');
    // A recent is not an edit target — bookmarking it must ADD a preset.
    expect(src).toContain('setEditingId(p.saved ? p.id : null);');
  });

  it('drives the command chips from the input text, so the two cannot disagree', () => {
    expect(src).toContain('const activeCommandId = cmdChoices.find((c) => c.command === typedCommand)?.id ?? null;');
    expect(src).toContain('onClick={() => setCommand(c.command)}');
  });
});
