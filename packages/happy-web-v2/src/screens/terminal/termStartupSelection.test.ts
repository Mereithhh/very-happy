/**
 * B-334 source assertions for the create-open wiring. The behavior lives
 * inside the ~600-line terminal effect (a live xterm + socket), so these pin
 * the three properties that a refactor could silently drop:
 *   · the URL selection is RESOLVED, never sent as text;
 *   · it applies to the create-open only, and is cleared with `fresh`;
 *   · the auto-title heuristics read what THIS open actually sent, so an
 *     explicit "no command" still gets the plain-shell fallback title.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');

describe('terminal startup-command selection wiring', () => {
  it('reads the selection as an id and resolves it against the saved presets', () => {
    expect(src).toContain("createStartupIdRef.current = params.get('cmd') || undefined;");
    expect(src).toContain('resolveStartupCommand({');
    expect(src).toContain('selectionId: createStartupIdRef.current,');
    expect(src).toContain('globalCommand: startupCommandRef.current,');
    // The command itself must never be taken from the URL.
    expect(src).not.toContain("params.get('startupCommand')");
  });

  it('applies the selection to the create-open only, and clears the param with fresh', () => {
    const open = src.slice(src.indexOf('openStartupCommand = attach'));
    expect(open.slice(0, 400)).toContain(': startupCommandRef.current;');
    expect(src).toContain("next.delete('cmd');");
  });

  it('sends the resolved command, so an explicit no-command is expressible', () => {
    expect(src).toContain('startupCommand: openStartupCommand,');
    // The old `(resume || global)` chain could not express undefined; a `||`
    // reintroduced here would turn "no command" back into the global one.
    expect(src).not.toContain('|| startupCommandRef.current)');
  });

  it('titles from the command THIS open sent, not from the global setting', () => {
    expect(src).not.toContain('if (startupCommandRef.current?.trim()) { titled = true; return; }');
    expect(src.match(/if \(openStartupCommand\?\.trim\(\)\) \{ titled = true; return; \}/g)).toHaveLength(2);
  });
});
