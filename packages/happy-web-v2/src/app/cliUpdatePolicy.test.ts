import { describe, expect, it } from 'vitest';
import { cliUpdateInstallCommand, machineCliUpdateNotice, visibleCliUpdateNotices } from './cliUpdatePolicy';

const machine = (id: string, current: string, recommended: string | null, minimum: string | null = null) => ({
  id,
  active: true,
  metadata: { host: `host-${id}`, happyCliVersion: current },
  daemonState: { cliUpdate: { currentVersion: current, recommendedVersion: recommended, minimumVersion: minimum, checkedAt: 1 } },
});

describe('CLI update notices', () => {
  it('classifies available, required and current machines', () => {
    expect(machineCliUpdateNotice(machine('a', '0.2.50', '0.2.68', '0.2.34'))?.severity).toBe('available');
    expect(machineCliUpdateNotice(machine('b', '0.2.20', '0.2.68', '0.2.34'))?.severity).toBe('required');
    expect(machineCliUpdateNotice(machine('c', '0.2.68', '0.2.68', '0.2.34'))).toBeNull();
  });

  it('dismisses only the acknowledged target and never hides required updates', () => {
    expect(visibleCliUpdateNotices([machine('a', '0.2.50', '0.2.68')], { a: '0.2.68' })).toEqual([]);
    expect(visibleCliUpdateNotices([machine('a', '0.2.50', '0.2.69')], { a: '0.2.68' })).toHaveLength(1);
    expect(visibleCliUpdateNotices([machine('a', '0.2.20', '0.2.68', '0.2.34')], { a: '0.2.68' })).toHaveLength(1);
  });

  it('puts required machines first and ignores malformed policy values', () => {
    const notices = visibleCliUpdateNotices([
      machine('available', '0.2.50', '0.2.68', '0.2.34'),
      machine('required', '0.2.20', '0.2.68', '0.2.34'),
      machine('bad', '0.2.20', 'latest', null),
    ], {});
    expect(notices.map((notice) => notice.machineId)).toEqual(['required', 'available']);
  });

  it('builds an exact fixed-package command only for a valid target', () => {
    expect(cliUpdateInstallCommand('0.2.68')).toContain('very-happy-cli@0.2.68');
    expect(machineCliUpdateNotice(machine('pre', '0.2.68-beta.1', '0.2.68'))?.severity).toBe('available');
    expect(cliUpdateInstallCommand('latest')).toBeNull();
    expect(cliUpdateInstallCommand('0.2.68+build.1')).toContain('@0.2.68+build.1');
    expect(cliUpdateInstallCommand('0.2.68-01')).toBeNull();
    expect(machineCliUpdateNotice(machine('pre-order', '0.2.68-beta.2', '0.2.68-beta.10'))?.severity).toBe('available');
  });

  it('never raises a global banner for an offline cached machine', () => {
    const offline = { ...machine('offline', '0.2.20', '0.2.68', '0.2.34'), active: false };
    expect(visibleCliUpdateNotices([offline], {})).toEqual([]);
  });
});
