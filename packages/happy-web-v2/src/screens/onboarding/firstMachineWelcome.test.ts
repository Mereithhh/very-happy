import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  emitFirstMachineConnected,
  shouldAnnounceFirstMachine,
  subscribeFirstMachineConnected,
} from './firstMachineWelcome';

describe('first-machine welcome signal', () => {
  it('announces only a genuinely first, previously unknown machine', () => {
    expect(shouldAnnounceFirstMachine(0, false)).toBe(true);
    expect(shouldAnnounceFirstMachine(1, false)).toBe(false);
    expect(shouldAnnounceFirstMachine(0, true)).toBe(false);
  });

  it('is tab-local, one-shot for an unsubscribed consumer, and carries no credentials', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFirstMachineConnected(listener);

    emitFirstMachineConnected({ machineId: 'machine-1' });
    unsubscribe();
    emitFirstMachineConnected({ machineId: 'machine-2' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ machineId: 'machine-1' });
  });

  it('wires the realtime first-machine edge to the authenticated workspace handoff', () => {
    const sync = readFileSync(new URL('../../sync/sync.ts', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../app/AppRoot.tsx', import.meta.url), 'utf8');

    expect(sync).toContain('if (announceFirstMachine) emitFirstMachineConnected({ machineId })');
    expect(app).toContain("navigate('/', { replace: true })");
    expect(app).toContain("t('workspaceGuide.firstMachineConnectedTitle')");
    expect(app).toContain('<FirstMachineWelcome />');
  });
});
