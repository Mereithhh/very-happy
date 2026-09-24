import { describe, expect, it } from 'vitest';
import { INSTALLED_NOT_RUNNING_GRACE_MS, cliUpdateAcknowledgement, cliUpdateCommandForNotice, cliUpdateInstallCommand, cliUpdateProblem, isCliVersionBelow, machineCliUpdateNotice, visibleCliUpdateNotices } from './cliUpdatePolicy';

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

  it('B-470: an attention notice (failed / manual_required) can be put away too, and comes back for a newer target', () => {
    const failed = { ...machine('a', '0.2.50', '0.2.68'), daemonState: { ...machine('a', '0.2.50', '0.2.68').daemonState, cliUpdate: { ...machine('a', '0.2.50', '0.2.68').daemonState!.cliUpdate, checkedAt: Date.now(), autoUpdate: { state: 'failed', version: '0.2.68' } } } };
    const notice = machineCliUpdateNotice(failed as any, Date.now())!;
    expect(notice.delivery).toBe('attention');
    // a plain acknowledgement (the user waved the progress card away) does NOT hide a failure…
    expect(visibleCliUpdateNotices([failed as any], { a: '0.2.68' }, Date.now())).toHaveLength(1);
    // …but closing the attention card itself does, for that target
    expect(cliUpdateAcknowledgement(notice)).toBe('0.2.68!');
    expect(visibleCliUpdateNotices([failed as any], { a: '0.2.68!' }, Date.now())).toEqual([]);
    // a newer target brings it back
    const newer = { ...failed, daemonState: { cliUpdate: { ...failed.daemonState.cliUpdate, recommendedVersion: '0.2.69' } } };
    expect(visibleCliUpdateNotices([newer as any], { a: '0.2.68!' }, Date.now())).toHaveLength(1);
    // required never hides
    expect(visibleCliUpdateNotices([machine('r', '0.2.20', '0.2.68', '0.2.34')], { r: '0.2.68!' })).toHaveLength(1);
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
    expect(cliUpdateInstallCommand('0.2.68')).toMatch(/&& very-happy daemon start$/);
    expect(machineCliUpdateNotice(machine('pre', '0.2.68-beta.1', '0.2.68'))?.severity).toBe('available');
    expect(cliUpdateInstallCommand('latest')).toBeNull();
    expect(cliUpdateInstallCommand('0.2.68+build.1')).toContain('@0.2.68+build.1');
    expect(cliUpdateInstallCommand('0.2.68-01')).toBeNull();
    expect(machineCliUpdateNotice(machine('pre-order', '0.2.68-beta.2', '0.2.68-beta.10'))?.severity).toBe('available');
  });

  it('compares exact CLI versions without treating malformed values as old', () => {
    expect(isCliVersionBelow('0.2.67', '0.2.68')).toBe(true);
    expect(isCliVersionBelow('0.2.68-beta.1', '0.2.68')).toBe(true);
    expect(isCliVersionBelow('0.2.68', '0.2.68')).toBe(false);
    expect(isCliVersionBelow('latest', '0.2.68')).toBe(false);
  });

  it('never raises a global banner for an offline cached machine', () => {
    const offline = { ...machine('offline', '0.2.20', '0.2.68', '0.2.34'), active: false };
    expect(visibleCliUpdateNotices([offline], {})).toEqual([]);
  });
});

describe('automatic update messaging', () => {
  const now = 1_800_000_000_000;
  const updating = (state = 'waiting_idle', target: string | null = '0.2.126') => ({
    ...machine('a', '0.2.120', '0.2.126'),
    daemonState: { cliUpdate: { currentVersion: '0.2.120', recommendedVersion: '0.2.126', checkedAt: now,
      autoUpdateVersion: target, autoUpdate: { state, version: target } } },
  });
  it.each(['waiting_idle', 'installing', 'installed'])('assures no manual action only for confirmed %s updates', state => {
    expect(machineCliUpdateNotice(updating(state), now)?.delivery).toBe('automatic');
    expect(machineCliUpdateNotice(updating(state, '0.2.122'), now)?.delivery).toBe('pending');
  });
  it('does not confuse a recommendation with an automatic rollout', () => {
    expect(machineCliUpdateNotice(updating('current', '0.2.122'), now)?.delivery).toBe('pending');
    expect(machineCliUpdateNotice(updating('unapproved', null), now)?.delivery).toBe('pending');
    expect(machineCliUpdateNotice(machine('old-cli', '0.2.120', '0.2.126'), now)?.delivery).toBe('unknown');
  });
  it.each(['failed', 'disabled', 'manual_required'])('retains recovery for %s', state => {
    expect(machineCliUpdateNotice(updating(state), now)?.delivery).toBe('attention');
  });
  it('never promises automatic completion from stale, offline or conflicting state', () => {
    expect(machineCliUpdateNotice(updating(), now + 66 * 60_000)?.delivery).toBe('unknown');
    expect(machineCliUpdateNotice(updating(), now - 61_000)?.delivery).toBe('unknown');
    expect(machineCliUpdateNotice({ ...updating(), active: false }, now)?.delivery).toBe('unknown');
    const held = updating('installed');
    Object.assign(held.daemonState.cliUpdate, { handoverHold: { reason: 'preflight failed' } });
    expect(machineCliUpdateNotice(held, now)?.delivery).toBe('attention');
    const mismatched = updating();
    mismatched.daemonState.cliUpdate.autoUpdate.version = '0.2.122';
    expect(machineCliUpdateNotice(mismatched, now)?.delivery).toBe('unknown');
  });
  it('never points below the minimum or says no action needed for an uncovered required update', () => {
    const required = updating('current', '0.2.122');
    Object.assign(required.daemonState.cliUpdate, { minimumVersion: '0.2.130' });
    expect(machineCliUpdateNotice(required, now)).toMatchObject({severity: 'required', targetVersion: '0.2.130', delivery: 'unknown'});
  });
  it('prioritizes a failed machine over one updating automatically', () => {
    const failed = {...updating('failed'), id:'z', metadata:{host:'z'}};
    expect(visibleCliUpdateNotices([updating(), failed], {}, now)[0].machineId).toBe('z');
  });
});

 it('reports the actual automatic target and resurfaces a failure after dismissing progress', () => {
   const now = Date.now();
   const m = machine('a', '0.2.120', '0.2.126');
   Object.assign(m.daemonState.cliUpdate, { checkedAt: now, autoUpdateVersion: '0.2.128', autoUpdate: {state:'installing', version:'0.2.128'} });
   expect(machineCliUpdateNotice(m, now)).toMatchObject({delivery:'automatic', automaticVersion:'0.2.128', targetVersion:'0.2.126'});
   expect(visibleCliUpdateNotices([m], {a:'0.2.126'}, now)).toHaveLength(0);
   Object.assign(m.daemonState.cliUpdate, {autoUpdate: {state:'failed', version:'0.2.128'}});
   expect(visibleCliUpdateNotices([m], {a:'0.2.126'}, now)).toHaveLength(1);
 });

it('recognizes only fresh, explicitly manual progress for the exact recommendation', () => {
 const now=Date.now(); const m=machine('a','0.2.132','0.2.133');
 Object.assign(m.daemonState.cliUpdate,{checkedAt:now,autoUpdateVersion:null,autoUpdate:{state:'waiting_idle',version:'0.2.133',source:'manual'}});
 expect(machineCliUpdateNotice(m,now)).toMatchObject({delivery:'automatic',automaticVersion:'0.2.133'});
 expect(machineCliUpdateNotice(m,now+66*60_000)?.delivery).toBe('unknown');
 Object.assign(m.daemonState.cliUpdate,{autoUpdate:{state:'waiting_idle',version:'0.2.133'}});
 expect(machineCliUpdateNotice(m,now)?.delivery).not.toBe('automatic');
 Object.assign(m.daemonState.cliUpdate,{autoUpdate:{state:'waiting_idle',version:'0.2.134',source:'manual'}});
 expect(machineCliUpdateNotice(m,now)?.delivery).not.toBe('automatic');
});

describe('B-489 update that never reached the running copy', () => {
  const now = 1_800_000_000_000;
  // Shape reported by the SageMaker daemon: 0.2.144 running, 0.2.149 "installed" into /opt/conda.
  const stuck = (state: string, detail?: string, installedAgoMs = 8 * 60 * 60_000) => ({
    ...machine('wei', '0.2.144', '0.2.149'),
    daemonState: { cliUpdate: { currentVersion: '0.2.144', recommendedVersion: '0.2.149', minimumVersion: '0.2.91', checkedAt: now,
      autoUpdateVersion: '0.2.149', retrySupported: true, manualUpdateSupported: true,
      autoUpdate: { state, version: '0.2.149', at: now - installedAgoMs, ...(detail ? { detail } : {}) } } },
  });
  it('an old daemon stuck on installed stops being "no action needed" after the grace period', () => {
    expect(machineCliUpdateNotice(stuck('installed', undefined, INSTALLED_NOT_RUNNING_GRACE_MS - 1), now)).toMatchObject({ delivery: 'automatic', problem: null });
    const notice = machineCliUpdateNotice(stuck('installed'), now)!;
    expect(notice).toMatchObject({ delivery: 'attention', problem: 'installed_not_running' });
    expect(cliUpdateCommandForNotice(notice)).toBe('P=$(readlink -f "$(command -v very-happy)") && npm install -g --prefix "${P%/lib/node_modules/very-happy-cli/*}" --allow-scripts=very-happy-cli,node-pty very-happy-cli@0.2.149 && very-happy daemon start');
    // Once the daemon runs the installed version there is nothing to report.
    const done = stuck('installed'); done.daemonState.cliUpdate.currentVersion = '0.2.149';
    expect(cliUpdateProblem(done.daemonState.cliUpdate, now)).toBeNull();
  });
  it('maps the new daemon details to readable problems', () => {
    expect(machineCliUpdateNotice(stuck('failed', 'installed_elsewhere'), now)).toMatchObject({ delivery: 'attention', problem: 'installed_elsewhere' });
    const location = machineCliUpdateNotice(stuck('manual_required', 'install_location_not_writable'), now)!;
    expect(location).toMatchObject({ delivery: 'attention', problem: 'install_location' });
    expect(cliUpdateCommandForNotice(location)).toBe(cliUpdateInstallCommand('0.2.149'));
    expect(machineCliUpdateNotice(stuck('failed', 'npm_install_failed'), now)?.problem).toBeNull();
  });
  it('the shell prefix strip lands on the running prefix', () => {
    const P = '/home/sagemaker-user/.local/lib/node_modules/very-happy-cli/bin/very-happy.mjs';
    expect(P.replace(/\/lib\/node_modules\/very-happy-cli\/.*$/, '')).toBe('/home/sagemaker-user/.local');
  });
});
