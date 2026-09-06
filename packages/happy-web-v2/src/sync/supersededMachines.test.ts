/**
 * B-361 — which machine rows are an install's abandoned leftovers.
 *
 * The incident: a host lost the `machineId` in its `settings.json`, registered
 * a second Machine row, and the first stayed behind serving its frozen
 * daemonState forever. The danger in fixing it is the opposite mistake —
 * hiding a machine someone is actually using — so the rules that prevent that
 * (online rows are never superseded; a partial identity never groups) get as
 * many tests as the happy path.
 */
import { describe, it, expect } from 'vitest';
import { supersededMachineIds, withoutSupersededMachines, type SupersedableMachine } from './supersededMachines';

const HOME = '/home/ubuntu/.happy';

function machine(over: Partial<SupersedableMachine> & { id: string }): SupersedableMachine {
  return {
    active: false,
    activeAt: 0,
    metadata: { host: 'ip-10-122-241-147', platform: 'linux', happyHomeDir: HOME },
    ...over,
  };
}

/** The real shape: retired row offline since the handover, live row online. */
const retired = machine({ id: 'old-mid', active: false, activeAt: 1_000 });
const live = machine({ id: 'new-mid', active: true, activeAt: 9_000 });

describe('supersededMachineIds', () => {
  it('supersedes the offline row when a newer row of the same install is live', () => {
    expect([...supersededMachineIds([retired, live])]).toEqual(['old-mid']);
  });

  it('is order-independent', () => {
    expect([...supersededMachineIds([live, retired])]).toEqual(['old-mid']);
  });

  it('NEVER supersedes an online row, even against a more recently active one', () => {
    // `~/.happy` copied to an identically named host with the same home path,
    // then re-authenticated: two live rows, and hiding either would be wrong.
    const alsoLive = machine({ id: 'other-live', active: true, activeAt: 9_999 });
    expect([...supersededMachineIds([live, alsoLive])]).toEqual([]);
  });

  it('collapses a group that is entirely offline, keeping the most recent', () => {
    const older = machine({ id: 'a', active: false, activeAt: 1_000 });
    const newer = machine({ id: 'b', active: false, activeAt: 5_000 });
    expect([...supersededMachineIds([older, newer])]).toEqual(['a']);
  });

  it('leaves a lone machine alone, online or off', () => {
    expect([...supersededMachineIds([live])]).toEqual([]);
    expect([...supersededMachineIds([retired])]).toEqual([]);
  });

  it('does not group two genuinely different machines', () => {
    const laptop = machine({ id: 'laptop', metadata: { host: 'mac-office', platform: 'darwin', happyHomeDir: '/Users/jojo/.happy' } });
    expect([...supersededMachineIds([laptop, live])]).toEqual([]);
  });

  it.each([
    ['host', { host: 'other-host', platform: 'linux', happyHomeDir: HOME }],
    ['platform', { host: 'ip-10-122-241-147', platform: 'darwin', happyHomeDir: HOME }],
    ['happyHomeDir', { host: 'ip-10-122-241-147', platform: 'linux', happyHomeDir: '/root/.happy' }],
  ])('needs all three parts to match — differing %s does not group', (_field, metadata) => {
    expect([...supersededMachineIds([machine({ id: 'x', metadata }), live])]).toEqual([]);
  });

  it.each([
    ['no metadata at all', null],
    ['metadata missing happyHomeDir', { host: 'ip-10-122-241-147', platform: 'linux' }],
    ['an empty string part', { host: '', platform: 'linux', happyHomeDir: HOME }],
  ])('never groups on a partial identity: %s', (_case, metadata) => {
    // Two old daemons that both report nothing must not collapse into one.
    const a = machine({ id: 'a', metadata: metadata as any });
    const b = machine({ id: 'b', metadata: metadata as any });
    expect([...supersededMachineIds([a, b, live])]).toEqual([]);
  });

  it.each([
    ['a space', ' '],
    ['a NUL', '\u0000'],
    ['a slash', '/'],
  ])('separates identities that a naive join on %s would collide', (_name, sep) => {
    // host "a" + platform "b<sep>c" must never key the same as
    // host "a<sep>b" + platform "c".
    const left = machine({ id: 'l', metadata: { host: 'a', platform: `b${sep}c`, happyHomeDir: HOME } });
    const right = machine({ id: 'r', metadata: { host: `a${sep}b`, platform: 'c', happyHomeDir: HOME } });
    expect([...supersededMachineIds([left, right])]).toEqual([]);
  });

  it('breaks an exact activeAt tie deterministically by id', () => {
    const a = machine({ id: 'aaa', active: false, activeAt: 5_000 });
    const z = machine({ id: 'zzz', active: false, activeAt: 5_000 });
    expect([...supersededMachineIds([z, a])]).toEqual(['zzz']);
    expect([...supersededMachineIds([a, z])]).toEqual(['zzz']);
  });

  it('supersedes every leftover when an install has accumulated three rows', () => {
    const older = machine({ id: 'a', active: false, activeAt: 1_000 });
    const old = machine({ id: 'b', active: false, activeAt: 2_000 });
    expect([...supersededMachineIds([older, old, live])].sort()).toEqual(['a', 'b']);
  });
});

describe('withoutSupersededMachines', () => {
  it('drops the leftovers', () => {
    expect(withoutSupersededMachines([retired, live]).map((m) => m.id)).toEqual(['new-mid']);
  });

  it('returns the SAME array when nothing is superseded (cheap for memoised callers)', () => {
    const input = [live];
    expect(withoutSupersededMachines(input)).toBe(input);
  });
});
