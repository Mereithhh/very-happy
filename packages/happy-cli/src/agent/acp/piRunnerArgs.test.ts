import { describe, expect, it } from 'vitest';
import { parsePiRunnerArgs } from './piRunnerArgs';

describe('parsePiRunnerArgs', () => {
  it('accepts the exact argv the daemon uses for every backend', () => {
    expect(parsePiRunnerArgs(['--happy-starting-mode', 'remote', '--started-by', 'daemon'])).toEqual({
      startedBy: 'daemon',
      verbose: false,
      passthrough: [],
    });
  });

  it('drops --permission-mode instead of forwarding it to pi-acp', () => {
    // The Web launcher always sends one; pi-acp would reject it as an unknown option.
    const parsed = parsePiRunnerArgs([
      '--happy-starting-mode', 'remote', '--started-by', 'daemon', '--permission-mode', 'default',
    ]);
    expect(parsed.passthrough).toEqual([]);
    expect(parsed.startedBy).toBe('daemon');
  });

  it('passes everything after -- to the adapter untouched', () => {
    expect(parsePiRunnerArgs(['--verbose', '--', '--some-adapter-flag', 'x'])).toEqual({
      startedBy: undefined,
      verbose: true,
      passthrough: ['--some-adapter-flag', 'x'],
    });
  });

  it('rejects unknown options rather than silently eating them', () => {
    expect(() => parsePiRunnerArgs(['--model', 'x'])).toThrow(/Unknown option for very-happy pi: --model/);
  });

  it('ignores a malformed --started-by value', () => {
    expect(parsePiRunnerArgs(['--started-by', 'robot']).startedBy).toBeUndefined();
  });
});
