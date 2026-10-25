import { describe, it, expect, vi } from 'vitest';
import { createUpdateController, DEFAULT_BUSY_INSTALL_GRACE_MS, resolveBusyInstallGrace } from './updateController';
import type { StagedInstallOutcome } from './stagedInstall';
import type { CliUpdateState } from '@/api/types';
import type { InstallOutcome } from './npmInstall';
const policy: CliUpdateState = { currentVersion: '0.2.122', recommendedVersion: '0.2.123', minimumVersion: null, autoUpdateVersion: '0.2.123', checkedAt: 1000, status: 'available' };
function setup() {
  const deps = { policy: vi.fn(async () => policy), enabled: vi.fn(async () => true), idle: vi.fn(() => true), install: vi.fn(async () => 1 as number | null), publish: vi.fn(), now: () => 1000 };
  return { deps, controller: createUpdateController(deps) };
}
describe('update recovery lifecycle', () => {
  it('publishes busy waits then installs once and retains failures across checks', async () => {
    const {deps, controller} = setup(); deps.idle.mockReturnValue(false);
    await controller.refresh(); expect(deps.publish.mock.lastCall?.[0].autoUpdate?.state).toBe('waiting_idle');
    expect(deps.install).not.toHaveBeenCalled(); deps.idle.mockReturnValue(true);
    await controller.tick(); await controller.refresh(); await controller.tick();
    expect(deps.install).toHaveBeenCalledTimes(1); expect(deps.publish.mock.lastCall?.[0].autoUpdate?.state).toBe('failed');
  });
  it('rechecks policy before retry and refuses revoked authorization', async () => {
    const {deps, controller} = setup(); await controller.refresh();
    deps.policy.mockResolvedValue({...policy, autoUpdateVersion: null});
    expect(await controller.retry('0.2.123')).toHaveProperty('error'); expect(deps.install).toHaveBeenCalledTimes(1);
  });
  it('accepts one explicit retry but does not install while busy or clear twice', async () => {
    vi.useFakeTimers();
    try {
      const {deps, controller} = setup(); await controller.refresh(); deps.idle.mockReturnValue(false);
      expect(await controller.retry('0.2.123')).toEqual({accepted: true});
      expect(await controller.retry('0.2.123')).toHaveProperty('error');
      await vi.runAllTimersAsync(); expect(deps.install).toHaveBeenCalledTimes(1);
      deps.idle.mockReturnValue(true); await Promise.all([controller.tick(), controller.tick()]);
      expect(deps.install).toHaveBeenCalledTimes(2); await controller.tick(); expect(deps.install).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('does not mistake installed for a running new daemon or repeat installation', async () => {
    const {deps, controller} = setup(); deps.install.mockResolvedValue(0);
    await controller.refresh(); await controller.refresh();
    expect(deps.install).toHaveBeenCalledTimes(1); expect(deps.publish.mock.lastCall?.[0]).toMatchObject({currentVersion: '0.2.122',autoUpdate:{state:'installed'}});
  });
});

describe('operation fence', () => {
  it('does not replace policy while an idle decision is suspended', async () => {
    const {deps, controller} = setup(); deps.idle.mockReturnValue(false);
    await controller.refresh();
    let resume!:()=>void;
    deps.enabled.mockImplementationOnce(()=>new Promise(resolve=>{resume=()=>resolve(true);}));
    deps.idle.mockReturnValue(true);
    const pending=controller.tick();
    deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null});
    await controller.refresh(); // skipped while a decision owns the fence
    expect(deps.policy).toHaveBeenCalledTimes(1);
    resume(); await pending;
    await controller.refresh(); // revoked policy is applied only after the operation completes
    expect(deps.publish.mock.lastCall?.[0].autoUpdate?.state).toBe('unapproved');
    expect(deps.install).toHaveBeenCalledTimes(1);
  });
  it('preflight cannot overlap pending settings or installation',async()=>{
    const {deps,controller}=setup(); deps.idle.mockReturnValue(false); await controller.refresh();
    let resume!:()=>void;
    deps.enabled.mockImplementationOnce(()=>new Promise(resolve=>{resume=()=>resolve(true);}));
    deps.idle.mockReturnValue(true); const pending=controller.tick(); const preflight=vi.fn(async()=>{});
    await controller.withHandover(preflight); expect(preflight).not.toHaveBeenCalled();
    resume(); await pending; await controller.withHandover(preflight); expect(preflight).toHaveBeenCalledTimes(1);
  });
  it('holds the fence across preflight and ownership release',async()=>{
    const {deps,controller}=setup(); deps.idle.mockReturnValue(false); await controller.refresh();
    let resume!:()=>void;
    const handover=controller.withHandover(()=>new Promise(resolve=>{resume=resolve;}));
    deps.idle.mockReturnValue(true); await controller.tick(); await controller.refresh();
    expect(deps.install).not.toHaveBeenCalled(); resume(); await handover;
    await controller.tick(); expect(deps.install).toHaveBeenCalledTimes(1);
  });
  it('keeps a handover failure visible and permits a verified explicit retry',async()=>{
    vi.useFakeTimers(); try {
      const {deps,controller}=setup(); deps.install.mockResolvedValue(0); await controller.refresh();
      await controller.withHandover(async()=>controller.holdHandover('bundle did not start'));
      deps.policy.mockResolvedValue({...policy,checkedAt:1001}); await controller.refresh();
      expect(deps.publish.mock.lastCall?.[0]).toMatchObject({autoUpdate:{state:'failed'},handoverHold:{reason:'bundle did not start'}});
      expect(await controller.retry('0.2.123')).toEqual({accepted:true});
      await vi.runAllTimersAsync(); expect(deps.install).toHaveBeenCalledTimes(2);
      await controller.withHandover(async()=>controller.holdHandover('bundle did not start'));
      expect(deps.publish.mock.lastCall?.[0].autoUpdate?.state).toBe('failed');
    } finally { vi.useRealTimers(); }
  });
  it('blocks retries and handover after an unconfirmed process-tree termination',async()=>{
    const {deps,controller}=setup(); deps.install.mockResolvedValue('blocked' as any); await controller.refresh();
    const preflight=vi.fn(async()=>{}); await controller.withHandover(preflight); await controller.tick();
    expect(preflight).not.toHaveBeenCalled(); expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.publish.mock.lastCall?.[0]).toMatchObject({retrySupported:false,autoUpdate:{state:'manual_required'}});
    expect(await controller.retry('0.2.123')).toHaveProperty('error');
  });
});

describe('explicit update before rollout', () => {
  it('accepts without installing inside RPC, waits for idle, and never changes automatic opt-out', async () => {
    vi.useFakeTimers(); try {
      const {deps, controller} = setup(); deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null});
      deps.enabled.mockResolvedValue(false); deps.idle.mockReturnValue(false); deps.install.mockResolvedValue(0);
      await controller.refresh(); expect(deps.install).not.toHaveBeenCalled();
      expect(await controller.request('0.2.123')).toEqual({accepted:true});
      expect(deps.install).not.toHaveBeenCalled();
      expect(deps.publish.mock.lastCall?.[0]).toMatchObject({manualUpdateSupported:true,autoUpdateVersion:null,autoUpdate:{state:'waiting_idle',source:'manual',version:'0.2.123'}});
      expect(await controller.request('0.2.123')).toEqual({accepted:true});
      await vi.runAllTimersAsync(); expect(deps.install).not.toHaveBeenCalled();
      deps.idle.mockReturnValue(true); await Promise.all([controller.tick(),controller.tick()]);
      await controller.refresh(); await controller.tick();
      expect(deps.install).toHaveBeenCalledExactlyOnceWith('0.2.123');
      expect(deps.publish.mock.lastCall?.[0]).toMatchObject({currentVersion:'0.2.122',autoUpdate:{state:'installed',source:'manual'}});
    } finally { vi.useRealTimers(); }
  });
  it.each([
    {recommendedVersion:'0.2.124'}, {checkedAt:NaN}, {checkedAt:-4_000_000}, {checkedAt:100_000},
    {currentVersion:'0.2.123'}, {currentVersion:'0.2.124'}, {minimumVersion:'0.2.124'}, {minimumVersion:'bad'},
  ])('rejects obsolete or invalid fresh policy %j',async change=>{
    const {deps,controller}=setup(); deps.policy.mockResolvedValue({...policy,...change});
    expect(await controller.request('0.2.123')).toHaveProperty('error');
    expect(deps.install).not.toHaveBeenCalled(); expect(deps.publish).not.toHaveBeenCalled();
  });
  it.each([null,undefined,{},'latest','0.2.123; echo unsafe'])('rejects invalid requested version %j',async version=>{
    const {deps,controller}=setup(); expect(await controller.request(version)).toHaveProperty('error'); expect(deps.install).not.toHaveBeenCalled();
  });
  it.each([{recommendedVersion:'0.2.124'},{minimumVersion:'0.2.124'}])('revokes a waiting manual request when policy changes %j',async change=>{
    vi.useFakeTimers(); try {
      const {deps,controller}=setup(); deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null}); deps.idle.mockReturnValue(false);
      await controller.request('0.2.123'); await vi.runAllTimersAsync();
      deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null,...change}); deps.idle.mockReturnValue(true);
      await controller.refresh(); await controller.tick(); expect(deps.install).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });
  it('retains manual failure, retries only explicitly, and revalidates minimum',async()=>{
    vi.useFakeTimers(); try {
      const {deps,controller}=setup(); deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null}); deps.enabled.mockResolvedValue(false);
      await controller.request('0.2.123'); await vi.runAllTimersAsync(); await controller.refresh(); await controller.tick();
      expect(deps.install).toHaveBeenCalledTimes(1);
      deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null,minimumVersion:'0.2.124'});
      expect(await controller.retry('0.2.123')).toHaveProperty('error');
      deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null});
      expect(await controller.retry('0.2.123')).toEqual({accepted:true}); await vi.runAllTimersAsync();
      expect(deps.install).toHaveBeenCalledTimes(2);
    } finally {vi.useRealTimers();}
  });
  it('cannot overlap handover or override a blocked installer',async()=>{
    const {deps,controller}=setup(); let resume!:()=>void;
    const handover=controller.withHandover(()=>new Promise(resolve=>{resume=resolve;}));
    expect(await controller.request('0.2.123')).toHaveProperty('error'); resume(); await handover;
    deps.install.mockResolvedValue('blocked' as any); await controller.refresh();
    expect(await controller.request('0.2.123')).toEqual({error:'manual_recovery_required'});
    expect(deps.publish.mock.lastCall?.[0].manualUpdateSupported).toBe(false);
  });
});

it('disarms a queued manual intent when a duplicate request discovers revoked policy', async()=>{
 vi.useFakeTimers(); try {
  const {deps,controller}=setup();deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null});deps.idle.mockReturnValue(false);
  await controller.request('0.2.123');await vi.runAllTimersAsync();
  deps.policy.mockResolvedValue({...policy,autoUpdateVersion:null,recommendedVersion:'0.2.124'});
  expect(await controller.request('0.2.123')).toHaveProperty('error');
  deps.idle.mockReturnValue(true);await controller.tick();expect(deps.install).not.toHaveBeenCalled();
 } finally {vi.useRealTimers();}
});

describe('B-489 install location outcomes', () => {
  function locationSetup(result: InstallOutcome) {
    const deps = { policy: vi.fn(async () => policy), enabled: vi.fn(async () => true), idle: vi.fn(() => true), install: vi.fn(async (): Promise<InstallOutcome> => result), publish: vi.fn(), now: () => 1000 };
    return { deps, controller: createUpdateController(deps) };
  }
  it('reports npm success that did not change the running copy as failed, never installed', async () => {
    const {deps, controller} = locationSetup({ failed: 'installed_elsewhere' });
    await controller.refresh(); await controller.refresh();
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.publish.mock.lastCall?.[0].autoUpdate).toMatchObject({ state: 'failed', version: '0.2.123', detail: 'installed_elsewhere' });
    // Still an ordinary failure: explicit retry stays available.
    expect(deps.publish.mock.lastCall?.[0].retrySupported).toBe(true);
  });
  it('an unusable install location asks for a manual update once and keeps the fence open', async () => {
    const {deps, controller} = locationSetup({ manual: 'install_location_not_writable' });
    await controller.refresh(); await controller.tick(); await controller.refresh();
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.publish.mock.lastCall?.[0]).toMatchObject({ retrySupported: true, manualUpdateSupported: true, autoUpdate: { state: 'manual_required', detail: 'install_location_not_writable' } });
    // A newer approved target is evaluated again.
    deps.policy.mockResolvedValue({ ...policy, recommendedVersion: '0.2.124', autoUpdateVersion: '0.2.124', checkedAt: 1000 });
    await controller.refresh(); expect(deps.install).toHaveBeenCalledTimes(2);
  });
});

describe('B-718 machine page facts', () => {
  it('reports the on/off setting with every published state', async () => {
    const {deps, controller} = setup(); deps.idle.mockReturnValue(false);
    await controller.refresh();
    expect(deps.publish.mock.lastCall?.[0]).toMatchObject({ autoUpdateEnabled: true, autoUpdate: { state: 'waiting_idle' } });
    deps.enabled.mockResolvedValue(false);
    await controller.tick();
    expect(deps.publish.mock.lastCall?.[0]).toMatchObject({ autoUpdateEnabled: false, autoUpdate: { state: 'disabled' } });
    expect(deps.install).not.toHaveBeenCalled();
  });
  it('records a completed automatic install and reports the previous daemon\'s record', async () => {
    const written: unknown[] = [];
    const {deps} = setup(); deps.install.mockResolvedValue(0);
    const controller = createUpdateController({ ...deps, lastInstall: { read: () => null, write: (r) => { written.push(r); } } });
    await controller.refresh();
    expect(written).toEqual([{ from: '0.2.122', to: '0.2.123', at: 1000, source: 'auto' }]);
    expect(deps.publish.mock.lastCall?.[0].lastInstall).toEqual(written[0]);
    // The replacement daemon reads it back and shows it next to "current".
    const next = setup();
    next.deps.policy.mockResolvedValue({ ...policy, currentVersion: '0.2.123' });
    const replaced = createUpdateController({ ...next.deps, lastInstall: { read: () => written[0] as never, write: () => undefined } });
    await replaced.refresh();
    expect(next.deps.publish.mock.lastCall?.[0]).toMatchObject({ autoUpdate: { state: 'current' }, lastInstall: { to: '0.2.123', source: 'auto' } });
  });
  it('does not record failed installs', async () => {
    const write = vi.fn();
    const {deps} = setup();
    const controller = createUpdateController({ ...deps, lastInstall: { read: () => null, write } });
    await controller.refresh();
    expect(write).not.toHaveBeenCalled();
    expect(deps.publish.mock.lastCall?.[0].lastInstall).toBeUndefined();
  });
  it('exposes the held target for the announcement handler', async () => {
    const {controller} = setup();
    expect(controller.currentTarget()).toBeNull();
    await controller.refresh();
    expect(controller.currentTarget()).toBe('0.2.123');
  });
});

describe('busy machines (B-817)', () => {
  function busySetup(grace = 15 * 60_000) {
    let clock = 1000;
    const deps = {
      policy: vi.fn(async () => policy), enabled: vi.fn(async () => true), idle: vi.fn(() => false),
      install: vi.fn(async (): Promise<InstallOutcome> => 0), installWhileBusy: vi.fn(async (): Promise<StagedInstallOutcome> => 0),
      installFenced: vi.fn(() => false), busyGraceMs: grace, publish: vi.fn(), now: () => clock,
    };
    return { deps, controller: createUpdateController(deps), advance: (ms: number) => { clock += ms; } };
  }
  const last = (deps: { publish: ReturnType<typeof vi.fn> }) => deps.publish.mock.lastCall?.[0].autoUpdate;

  it('waits for idle inside the grace period, then installs through the staged path', async () => {
    const { deps, controller, advance } = busySetup();
    await controller.refresh();
    expect(last(deps)?.state).toBe('waiting_idle');
    advance(15 * 60_000 - 1); await controller.tick();
    expect(deps.installWhileBusy).not.toHaveBeenCalled();
    advance(1); await controller.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledWith('0.2.123');
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.publish.mock.calls.map(([s]) => [s.autoUpdate?.state, s.autoUpdate?.detail])).toContainEqual(['installing', 'while_busy']);
    expect(last(deps)?.state).toBe('installed');
  });

  it('without an explicit grace the default 15 minutes applies', async () => {
    const { deps, advance } = busySetup();
    const { busyGraceMs: _omit, ...rest } = deps;
    const defaulted = createUpdateController(rest);
    await defaulted.refresh();
    advance(DEFAULT_BUSY_INSTALL_GRACE_MS - 1); await defaulted.tick();
    expect(deps.installWhileBusy).not.toHaveBeenCalled();
    advance(1); await defaulted.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledTimes(1);
  });

  it('an idle machine keeps the classic install, whatever the grace', async () => {
    const { deps, controller } = busySetup(0); deps.idle.mockReturnValue(true);
    await controller.refresh();
    expect(deps.install).toHaveBeenCalledTimes(1); expect(deps.installWhileBusy).not.toHaveBeenCalled();
  });

  it('a deferred staged install waits for a real idle moment and does not retry staged', async () => {
    const { deps, controller, advance } = busySetup(0);
    deps.installWhileBusy.mockResolvedValue({ deferred: 'staged_bin_map_changed' });
    await controller.refresh();
    expect(last(deps)).toMatchObject({ state: 'waiting_idle', detail: 'staged_bin_map_changed' });
    advance(60_000); await controller.tick(); await controller.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledTimes(1);
    expect(last(deps)).toMatchObject({ state: 'waiting_idle', detail: 'staged_bin_map_changed' });
    deps.idle.mockReturnValue(true); await controller.tick();
    expect(deps.install).toHaveBeenCalledTimes(1); expect(last(deps)?.state).toBe('installed');
  });

  it('never installs while busy during a harness install', async () => {
    const { deps, controller } = busySetup(0); deps.installFenced.mockReturnValue(true);
    await controller.refresh(); await controller.tick();
    expect(deps.installWhileBusy).not.toHaveBeenCalled(); expect(last(deps)?.state).toBe('waiting_idle');
    deps.installFenced.mockReturnValue(false); await controller.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledTimes(1);
  });

  it('a new target restarts the grace period', async () => {
    const { deps, controller, advance } = busySetup();
    await controller.refresh();
    advance(14 * 60_000);
    deps.policy.mockResolvedValue({ ...policy, recommendedVersion: '0.2.124', autoUpdateVersion: '0.2.124', checkedAt: 1000 + 14 * 60_000 });
    await controller.refresh();
    advance(2 * 60_000); await controller.tick();
    expect(deps.installWhileBusy).not.toHaveBeenCalled();
    advance(13 * 60_000); await controller.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledWith('0.2.124');
  });

  it('a staged npm failure is terminal like any other failure', async () => {
    const { deps, controller } = busySetup(0); deps.installWhileBusy.mockResolvedValue(1);
    await controller.refresh(); await controller.tick();
    expect(deps.installWhileBusy).toHaveBeenCalledTimes(1); expect(last(deps)?.state).toBe('failed');
  });
});

describe('resolveBusyInstallGrace', () => {
  it('defaults to 15 minutes and accepts only sane integers', () => {
    expect(resolveBusyInstallGrace(undefined)).toBe(DEFAULT_BUSY_INSTALL_GRACE_MS);
    expect(DEFAULT_BUSY_INSTALL_GRACE_MS).toBe(15 * 60_000);
    expect(resolveBusyInstallGrace('0')).toBe(0);
    expect(resolveBusyInstallGrace('30000')).toBe(30_000);
    for (const bad of ['', '-1', '1.5', 'soon', String(25 * 60 * 60_000)]) expect(resolveBusyInstallGrace(bad)).toBe(DEFAULT_BUSY_INSTALL_GRACE_MS);
  });
});
