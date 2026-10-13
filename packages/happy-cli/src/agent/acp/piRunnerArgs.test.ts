import { describe, expect, it } from 'vitest';
import {
  PI_ACP_PACKAGE,
  PI_ADAPTER_INSTALL_HINT,
  PI_PACKAGE,
  missingPiPrerequisites,
  parsePiRunnerArgs,
  piAdapterMissingHint,
  piInstallCommand,
  piSetupMessage,
} from './piRunnerArgs';

describe('parsePiRunnerArgs', () => {
  it('accepts the exact argv the daemon uses for every backend', () => {
    expect(parsePiRunnerArgs(['--happy-starting-mode', 'remote', '--started-by', 'daemon'])).toEqual({
      startedBy: 'daemon',
      verbose: false,
      passthrough: [],
    });
  });

  it('captures --permission-mode (sanitized) instead of forwarding it to pi-acp', () => {
    // The Web launcher always sends one; pi-acp would reject it as an unknown option,
    // so it never reaches passthrough — it goes to the pi-side gate via env/mode file.
    const parsed = parsePiRunnerArgs([
      '--happy-starting-mode', 'remote', '--started-by', 'daemon', '--permission-mode', 'bypassPermissions',
    ]);
    expect(parsed.passthrough).toEqual([]);
    expect(parsed.startedBy).toBe('daemon');
    expect(parsed.permissionMode).toBe('bypassPermissions');
  });

  it('maps the yolo alias to bypassPermissions and drops values outside the allowlist', () => {
    expect(parsePiRunnerArgs(['--permission-mode', 'yolo']).permissionMode).toBe('bypassPermissions');
    expect(parsePiRunnerArgs(['--permission-mode', 'plan']).permissionMode).toBe('plan');
    expect(parsePiRunnerArgs(['--permission-mode', 'acceptEdits']).permissionMode).toBe('acceptEdits');
    expect(parsePiRunnerArgs(['--permission-mode', 'default']).permissionMode).toBe('default');
    expect(parsePiRunnerArgs(['--permission-mode', 'safe-yolo']).permissionMode).toBeUndefined();
    expect(parsePiRunnerArgs(['--permission-mode', 'rm -rf'])).not.toHaveProperty('permissionMode');
  });

  it('still drops --happy-starting-mode and its value', () => {
    expect(parsePiRunnerArgs(['--happy-starting-mode', 'remote'])).toEqual({ verbose: false, passthrough: [] });
  });

  it('passes everything after -- to the adapter untouched', () => {
    expect(parsePiRunnerArgs(['--verbose', '--', '--some-adapter-flag', 'x'])).toEqual({
      startedBy: undefined,
      verbose: true,
      passthrough: ['--some-adapter-flag', 'x'],
    });
  });

  it('rejects unknown options rather than silently eating them', () => {
    expect(() => parsePiRunnerArgs(['--unknown', 'x'])).toThrow(/Unknown option for very-happy pi: --unknown/);
  });

  it('ignores a malformed --started-by value', () => {
    expect(parsePiRunnerArgs(['--started-by', 'robot']).startedBy).toBeUndefined();
  });
});

describe('piAdapterMissingHint', () => {
  it('returns the pinned install message for a missing executable', () => {
    // Shape of AcpBackend's `status: 'error'` detail when pi-acp is not on PATH.
    expect(piAdapterMissingHint('spawn pi-acp ENOENT')).toBe(piSetupMessage(['pi-acp']));
    expect(piAdapterMissingHint('spawn pi-acp ENOENT')).toContain('npm install -g pi-acp@0.0.33');
    expect(piAdapterMissingHint('spawn pi ENOENT')).toBe(piSetupMessage(['pi', 'pi-acp']));
    expect(PI_ADAPTER_INSTALL_HINT).toMatch(/pi-acp@\d+\.\d+\.\d+/);
    expect(PI_ADAPTER_INSTALL_HINT).toContain(PI_PACKAGE);
  });

  it('stays silent for every other failure', () => {
    expect(piAdapterMissingHint('pi backend error: exit code 1')).toBeNull();
    expect(piAdapterMissingHint(undefined)).toBeNull();
    expect(piAdapterMissingHint('')).toBeNull();
  });
});

// B-596: `very-happy pi` checks PATH before creating a session.
describe('missingPiPrerequisites', () => {
  const onPathOf = (...present: string[]) => (command: string) => present.includes(command);

  it('reports pi-acp alone when only the adapter is missing (the 2026-10-14 DSW case)', () => {
    expect(missingPiPrerequisites(onPathOf('pi'), {})).toEqual(['pi-acp']);
  });

  it('reports both, pi first, when neither is on PATH', () => {
    expect(missingPiPrerequisites(onPathOf(), {})).toEqual(['pi', 'pi-acp']);
  });

  it('is empty when both are on PATH', () => {
    expect(missingPiPrerequisites(onPathOf('pi', 'pi-acp'), {})).toEqual([]);
  });

  it('does not require pi on PATH when PI_ACP_PI_COMMAND names the executable', () => {
    expect(missingPiPrerequisites(onPathOf('pi-acp'), { PI_ACP_PI_COMMAND: '/opt/pi/bin/pi' })).toEqual([]);
    expect(missingPiPrerequisites(onPathOf(), { PI_ACP_PI_COMMAND: '/opt/pi/bin/pi' })).toEqual(['pi-acp']);
  });
});

describe('piInstallCommand / piSetupMessage', () => {
  it('installs exactly what is missing, with the adapter pinned', () => {
    expect(piInstallCommand(['pi-acp'])).toBe('npm install -g pi-acp@0.0.33');
    expect(piInstallCommand(['pi'])).toBe(`npm install -g ${PI_PACKAGE}`);
    expect(piInstallCommand(['pi', 'pi-acp'])).toBe(`npm install -g ${PI_PACKAGE} ${PI_ACP_PACKAGE}`);
    expect(piInstallCommand()).toBe(`npm install -g ${PI_PACKAGE} ${PI_ACP_PACKAGE}`);
  });

  it('names what is missing and carries the command on its own line', () => {
    const message = piSetupMessage(['pi-acp']);
    expect(message.split('\n')[0]).toBe('very-happy pi cannot start: the pi-acp adapter is not installed (not found on PATH).');
    expect(message.split('\n')).toContain('  npm install -g pi-acp@0.0.33');
    expect(piSetupMessage(['pi']).split('\n')[0]).toContain(': pi is not installed');
    expect(piSetupMessage(['pi', 'pi-acp']).split('\n')[0]).toContain(': pi and the pi-acp adapter are not installed');
  });
});

it('accepts provider-qualified initial model without passing it to the adapter argv', () => {
  expect(parsePiRunnerArgs(['--model', 'llm-hub/claude-fable-5-1'])).toEqual({ verbose: false, passthrough: [], model: 'llm-hub/claude-fable-5-1' });
  expect(() => parsePiRunnerArgs(['--model', '--evil'])).toThrow('Invalid --model');
});
