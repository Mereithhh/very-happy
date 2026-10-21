import { describe, expect, it } from 'vitest';
import { machineAutoUpdateSummary } from './machineAutoUpdate';

const base = { currentVersion: '0.2.179', recommendedVersion: '0.2.180', autoUpdateVersion: '0.2.180', checkedAt: 1000, manualUpdateSupported: true, autoUpdateEnabled: true, autoUpdate: { state: 'waiting_idle', version: '0.2.180', at: 1000 } };

describe('machineAutoUpdateSummary (B-718)', () => {
  it('shows on, running → target, last check and offers Update now', () => {
    expect(machineAutoUpdateSummary(base, '0.2.134', true)).toEqual({
      enabled: true, current: '0.2.179', target: '0.2.180', checkedAt: 1000, lastInstall: null, updateNowVersion: '0.2.180',
    });
  });
  it('reports off as off and still lets the owner update this machine on request', () => {
    const s = machineAutoUpdateSummary({ ...base, autoUpdateEnabled: false, autoUpdate: { state: 'disabled', version: '0.2.180', at: 1 } }, null, true);
    expect(s.enabled).toBe(false);
    expect(s.updateNowVersion).toBe('0.2.180');
  });
  it('carries the last completed update across the handover', () => {
    const s = machineAutoUpdateSummary({ ...base, currentVersion: '0.2.180', autoUpdate: { state: 'current', version: '0.2.180', at: 2 }, lastInstall: { from: '0.2.179', to: '0.2.180', at: 5, source: 'auto' } }, null, true);
    expect(s).toMatchObject({ target: null, updateNowVersion: null, lastInstall: { from: '0.2.179', to: '0.2.180', at: 5, auto: true } });
  });
  it('never offers Update now offline, while installing, for an old daemon or towards a version it already has', () => {
    expect(machineAutoUpdateSummary(base, null, false).updateNowVersion).toBeNull();
    expect(machineAutoUpdateSummary({ ...base, autoUpdate: { state: 'installing', version: '0.2.180', at: 1 } }, null, true).updateNowVersion).toBeNull();
    expect(machineAutoUpdateSummary({ ...base, manualUpdateSupported: undefined }, null, true).updateNowVersion).toBeNull();
    expect(machineAutoUpdateSummary({ ...base, currentVersion: '0.2.181' }, null, true)).toMatchObject({ target: null, updateNowVersion: null });
  });
  it('degrades for an old daemon: unknown on/off, metadata version as current', () => {
    const s = machineAutoUpdateSummary(undefined, '0.2.170', true);
    expect(s).toEqual({ enabled: null, current: '0.2.170', target: null, checkedAt: null, lastInstall: null, updateNowVersion: null });
  });
  it('ignores malformed fields', () => {
    const s = machineAutoUpdateSummary({ ...base, autoUpdateVersion: 'next', lastInstall: { from: 'x', to: '0.2.180', at: 1 }, autoUpdateEnabled: 'yes' }, null, true);
    expect(s).toMatchObject({ target: null, lastInstall: null, enabled: null });
  });
});
