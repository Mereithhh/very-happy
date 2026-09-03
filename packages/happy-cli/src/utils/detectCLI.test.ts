import { describe, expect, it } from 'vitest';
import { commandOnPath } from './detectCLI';

describe('commandOnPath', () => {
  it('finds a bare command name that is on PATH', () => {
    // `sh` exists on every POSIX box; PowerShell is the Windows equivalent.
    const probe = process.platform === 'win32' ? 'powershell' : 'sh';
    expect(commandOnPath(probe)).toBe(true);
  });

  it('reports a bare name that is not installed as absent', () => {
    expect(commandOnPath('very-happy-no-such-binary-xyz')).toBe(false);
  });

  it('refuses anything that is not a bare command name instead of shelling it out', () => {
    // The name is interpolated into `command -v <name>`; these must never reach the shell.
    expect(commandOnPath('sh; echo')).toBe(false);
    expect(commandOnPath('sh echo')).toBe(false);
    expect(commandOnPath('$(sh)')).toBe(false);
    expect(commandOnPath('')).toBe(false);
  });
});
