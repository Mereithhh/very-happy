import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation, AutomationRun } from '@slopus/happy-wire';

// apiAutomations pulls AuthContext → storage → localStorage at import time, so
// it is mocked wholesale (node environment, see testing/browserTestGlobals.ts).
const api = vi.hoisted(() => ({
  AutomationsApiError: class AutomationsApiError extends Error {
    constructor(public status: number, public code: string, public details?: Record<string, unknown>) { super(code); }
    get disabled() { return this.status === 404 && this.code === 'automations_disabled'; }
  },
  isAutomationsDisabled: (e: unknown) => e instanceof api.AutomationsApiError && e.disabled,
  listAutomations: vi.fn(),
  listRuns: vi.fn(),
  getAutomation: vi.fn(),
  listStickies: vi.fn(),
  ackRun: vi.fn(),
  cancelRun: vi.fn(),
  runAutomationNow: vi.fn(),
  pauseAutomation: vi.fn(),
  resumeAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));
vi.mock('@/sync/apiAutomations', () => api);

import { useAutomations } from './automationsStore';
const { AutomationsApiError } = api;

const auto = (id: string, over: Partial<Automation> = {}): Automation => ({
  id, name: id, description: null, machineId: 'm', status: 'active', trigger: { kind: 'manual' },
  action: { kind: 'script', command: ['true'] }, concurrency: 'skip', maxRuntimeMs: 60_000, nextRunAt: null,
  version: 1, lastRunAt: null, lastRunStatus: null, createdAt: 0, updatedAt: 0, ...over,
});
const run = (id: string, over: Partial<AutomationRun> = {}): AutomationRun => ({
  id, automationId: 'a', automationName: 'a', machineId: 'm', source: 'manual', dedupeKey: null, payload: null,
  status: 'failed', needsAttention: true, attentionReason: null, sessionId: null, stickyKey: null, scheduledFor: null,
  claimedAt: null, leaseUntil: null, startedAt: null, finishedAt: null, summary: null, error: null, exitCode: null,
  createdAt: 0, updatedAt: 0, ...over,
});
const disabled = () => new AutomationsApiError(404, 'automations_disabled');

beforeEach(() => {
  vi.clearAllMocks();
  useAutomations.setState({ enabled: null, automations: [], attention: [], runsByAutomation: {}, stickiesByAutomation: {}, error: null, loadedAt: null });
});

describe('automationsStore', () => {
  it('refreshOverview loads automations + attention runs and marks the feature enabled', async () => {
    api.listAutomations.mockResolvedValue({ automations: [auto('a')] });
    api.listRuns.mockResolvedValue({ runs: [run('r1')] });
    await useAutomations.getState().refreshOverview();
    const s = useAutomations.getState();
    expect(s.enabled).toBe(true);
    expect(s.automations.map((a) => a.id)).toEqual(['a']);
    expect(s.attention.map((r) => r.id)).toEqual(['r1']);
    expect(s.error).toBeNull();
    expect(api.listRuns).toHaveBeenCalledWith({ attention: true, limit: 100 });
  });

  it('404 automations_disabled hides the feature instead of erroring', async () => {
    useAutomations.setState({ automations: [auto('stale')], attention: [run('stale')] });
    api.listAutomations.mockRejectedValue(disabled());
    api.listRuns.mockResolvedValue({ runs: [] });
    await useAutomations.getState().refreshOverview();
    const s = useAutomations.getState();
    expect(s.enabled).toBe(false);
    expect(s.automations).toEqual([]);
    expect(s.attention).toEqual([]);
    expect(s.error).toBeNull();
  });

  it('other failures keep the previous data and surface the code', async () => {
    useAutomations.setState({ enabled: true, automations: [auto('keep')], attention: [run('keep')] });
    api.listAutomations.mockRejectedValue(new AutomationsApiError(500, 'boom'));
    api.listRuns.mockResolvedValue({ runs: [] });
    await useAutomations.getState().refreshOverview();
    const s = useAutomations.getState();
    expect(s.enabled).toBe(true);
    expect(s.automations.map((a) => a.id)).toEqual(['keep']);
    expect(s.attention.map((r) => r.id)).toEqual(['keep']);
    expect(s.error).toBe('boom');
  });

  it('ack drops the run from the attention band and updates the detail list', async () => {
    useAutomations.setState({ enabled: true, attention: [run('r1'), run('r2')], runsByAutomation: { a: [run('r1')] } });
    api.ackRun.mockResolvedValue({ run: run('r1', { needsAttention: false }) });
    await useAutomations.getState().ack('r1');
    const s = useAutomations.getState();
    expect(s.attention.map((r) => r.id)).toEqual(['r2']);
    expect(s.runsByAutomation.a[0].needsAttention).toBe(false);
  });

  it('cancel also acknowledges when the server leaves needsAttention on the cancelled run', async () => {
    useAutomations.setState({ enabled: true, attention: [run('r1', { status: 'running', attentionReason: 'needs_input' })] });
    api.cancelRun.mockResolvedValue({ run: run('r1', { status: 'cancelled', attentionReason: 'needs_input' }) });
    api.ackRun.mockResolvedValue({ run: run('r1', { status: 'cancelled', needsAttention: false, attentionReason: 'needs_input' }) });
    await useAutomations.getState().cancel('r1');
    expect(api.ackRun).toHaveBeenCalledWith('r1');
    expect(useAutomations.getState().attention).toEqual([]);
    // already clear → no extra ack
    api.cancelRun.mockResolvedValue({ run: run('r2', { status: 'cancelled', needsAttention: false }) });
    await useAutomations.getState().cancel('r2');
    expect(api.ackRun).toHaveBeenCalledTimes(1);
  });

  it('rerun prepends the new run to the detail list and only joins attention when flagged', async () => {
    useAutomations.setState({ enabled: true, attention: [], runsByAutomation: { a: [run('old')] } });
    api.runAutomationNow.mockResolvedValue({ run: run('new', { status: 'queued', needsAttention: false }) });
    const created = await useAutomations.getState().rerun('a');
    expect(created.id).toBe('new');
    const s = useAutomations.getState();
    expect(s.runsByAutomation.a.map((r) => r.id)).toEqual(['new', 'old']);
    expect(s.attention).toEqual([]);
  });

  it('remove clears the automation, its runs, stickies and attention rows', async () => {
    useAutomations.setState({
      enabled: true,
      automations: [auto('a'), auto('b')],
      attention: [run('ra', { automationId: 'a' }), run('rb', { automationId: 'b' })],
      runsByAutomation: { a: [run('ra')], b: [run('rb', { automationId: 'b' })] },
      stickiesByAutomation: { a: [{ key: 'k', sessionId: 's', updatedAt: 0 }] },
    });
    api.deleteAutomation.mockResolvedValue({ ok: true });
    await useAutomations.getState().remove('a');
    const s = useAutomations.getState();
    expect(s.automations.map((a) => a.id)).toEqual(['b']);
    expect(s.attention.map((r) => r.id)).toEqual(['rb']);
    expect(Object.keys(s.runsByAutomation)).toEqual(['b']);
    expect(s.stickiesByAutomation).toEqual({});
  });

  it('refreshAutomation on a plain 404 drops the automation locally (deleted elsewhere)', async () => {
    useAutomations.setState({ enabled: true, automations: [auto('gone')] });
    api.getAutomation.mockRejectedValue(new AutomationsApiError(404, 'automation_not_found'));
    api.listRuns.mockResolvedValue({ runs: [] });
    api.listStickies.mockResolvedValue({ stickies: [] });
    await useAutomations.getState().refreshAutomation('gone');
    expect(useAutomations.getState().automations).toEqual([]);
    expect(useAutomations.getState().error).toBeNull();
  });

  it('action failures propagate so the UI can toast, and the gate error flips enabled', async () => {
    useAutomations.setState({ enabled: true, automations: [auto('a')] });
    api.pauseAutomation.mockRejectedValue(new AutomationsApiError(409, 'stale_automation'));
    await expect(useAutomations.getState().pause('a')).rejects.toMatchObject({ code: 'stale_automation' });
    api.pauseAutomation.mockRejectedValue(disabled());
    await expect(useAutomations.getState().pause('a')).rejects.toMatchObject({ code: 'automations_disabled' });
    expect(useAutomations.getState().enabled).toBe(false);
    expect(useAutomations.getState().automations).toEqual([]);
  });
});
