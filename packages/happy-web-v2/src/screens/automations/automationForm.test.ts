import { describe, expect, it } from 'vitest';
import type { Automation } from '@slopus/happy-wire';
import {
  buildCreate,
  buildUpdate,
  cronLooksValid,
  cronPreview,
  draftFromAutomation,
  emptyDraft,
  epochToLocalInput,
  fireSnippets,
  formatDuration,
  isValidTimeZone,
  joinArgv,
  localInputToEpoch,
  parseDuration,
  splitArgv,
  validateDraft,
} from './automationForm';

const base = (over: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  name: 'daily',
  description: 'desc',
  machineId: 'm1',
  status: 'active',
  trigger: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Singapore' },
  action: { kind: 'spawn', agent: 'claude', directory: '~/p', prompt: 'hi', model: 'opus', permissionMode: 'yolo', worktree: true, sticky: { key: 'k-{{payload.id}}' } },
  concurrency: 'queue',
  maxRuntimeMs: 2 * 3_600_000,
  nextRunAt: null,
  version: 4,
  lastRunAt: null,
  lastRunStatus: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('durations', () => {
  it('parses the CLI vocabulary and bare minutes', () => {
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(2 * 86_400_000);
    expect(parseDuration(' 90 ')).toBe(90 * 60_000);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
  });
  it('formats back to the shortest form that parses again', () => {
    for (const ms of [60_000, 5_400_000, 86_400_000 + 3_600_000, 6 * 3_600_000, 45_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
    expect(formatDuration(6 * 3_600_000)).toBe('6h');
    expect(formatDuration(0)).toBe('');
  });
});

describe('argv', () => {
  it('splits like a shell would tokenise, without expansion', () => {
    expect(splitArgv('python3 sync.py --since "15 min" \'a b\'')).toEqual(['python3', 'sync.py', '--since', '15 min', 'a b']);
    expect(splitArgv('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
    expect(splitArgv('  rclone   sync  ')).toEqual(['rclone', 'sync']);
    expect(splitArgv('echo ""')).toEqual(['echo', '']);
    expect(splitArgv('echo $HOME')).toEqual(['echo', '$HOME']);
    expect(splitArgv('bad "quote')).toBeNull();
    expect(splitArgv('')).toEqual([]);
  });
  it('joinArgv round-trips through splitArgv', () => {
    for (const argv of [['a', 'b c', ''], ['echo', 'say "hi"'], ['x\\y']]) {
      expect(splitArgv(joinArgv(argv))).toEqual(argv);
    }
  });
});

describe('cron / tz / datetime helpers', () => {
  it('cronLooksValid accepts five fields and aliases only', () => {
    expect(cronLooksValid('0 9 * * 1-5')).toBe(true);
    expect(cronLooksValid('@daily')).toBe(true);
    expect(cronLooksValid('0 9 * *')).toBe(false);
    expect(cronLooksValid('0 9 * * * *')).toBe(false);
    expect(cronLooksValid('0 9 * * ?')).toBe(false);
  });
  it('isValidTimeZone uses Intl', () => {
    expect(isValidTimeZone('Asia/Singapore')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
  it('cronPreview words a valid expression and stays quiet otherwise', () => {
    expect(cronPreview('0 9 * * 1-5', 'UTC', 'en')).toBe('09:00 on weekdays · UTC');
    expect(cronPreview('17 3 */2 * *', 'UTC', 'en')).toBeNull();
    expect(cronPreview('nope', 'UTC', 'zh')).toBeNull();
  });
  it('datetime-local round-trips in the browser zone', () => {
    const at = new Date(2026, 8, 30, 13, 45).getTime();
    expect(epochToLocalInput(at)).toBe('2026-09-30T13:45');
    expect(localInputToEpoch('2026-09-30T13:45')).toBe(at);
    expect(localInputToEpoch('')).toBeNull();
    expect(localInputToEpoch('garbage')).toBeNull();
  });
});

describe('draft ↔ wire', () => {
  it('draftFromAutomation then buildUpdate yields an unchanged diff', () => {
    const a = base();
    const d = draftFromAutomation(a);
    expect(d.triggerKind).toBe('cron');
    expect(d.cronExpr).toBe('0 9 * * 1-5');
    expect(d.stickyKey).toBe('k-{{payload.id}}');
    expect(d.maxRuntime).toBe('2h');
    const r = buildUpdate(d, a);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).toEqual({ version: 4 });
      expect(r.changed).toBe(false);
    }
  });
  it('buildUpdate sends only what changed, with the version CAS', () => {
    const a = base();
    const d = draftFromAutomation(a);
    d.description = '';
    d.triggerKind = 'manual';
    d.concurrency = 'skip';
    d.model = '';
    const r = buildUpdate(d, a);
    expect(r.ok && r.body).toEqual({
      version: 4,
      description: null,
      trigger: { kind: 'manual' },
      concurrency: 'skip',
      action: { kind: 'spawn', agent: 'claude', directory: '~/p', prompt: 'hi', permissionMode: 'yolo', worktree: true, sticky: { key: 'k-{{payload.id}}' } },
    });
  });
  it('script and send drafts round-trip', () => {
    const script = base({ action: { kind: 'script', command: ['python3', 'sync.py', '--since', '15 min'], cwd: '/srv' }, trigger: { kind: 'interval', everyMs: 900_000, anchorAt: 5 } });
    const d = draftFromAutomation(script);
    expect(d.scriptCommand).toBe('python3 sync.py --since "15 min"');
    expect(d.intervalEvery).toBe('15m');
    const r = buildUpdate(d, script);
    expect(r.ok && r.body).toEqual({ version: 4 });
    const send = base({ action: { kind: 'send', sessionId: 's1', prompt: 'ping' }, trigger: { kind: 'once', at: new Date(2030, 0, 1, 8, 0).getTime() } });
    const d2 = draftFromAutomation(send);
    expect(d2.sendSessionId).toBe('s1');
    expect(d2.onceAt).toBe('2030-01-01T08:00');
    const r2 = buildUpdate(d2, send);
    expect(r2.ok && r2.body).toEqual({ version: 4 });
  });
  it('buildCreate produces a wire-valid body and omits blanks', () => {
    const d = emptyDraft({ name: 'nightly', machineId: 'm1', triggerKind: 'interval', intervalEvery: '1h', actionKind: 'script', scriptCommand: 'rclone sync a b:c', maxRuntime: '30m' });
    const r = buildCreate(d);
    expect(r.ok && r.body).toEqual({
      name: 'nightly',
      machineId: 'm1',
      trigger: { kind: 'interval', everyMs: 3_600_000 },
      action: { kind: 'script', command: ['rclone', 'sync', 'a', 'b:c'] },
      concurrency: 'skip',
      maxRuntimeMs: 1_800_000,
    });
  });
  it('validateDraft reports every bad field by key', () => {
    const d = emptyDraft({ name: 'Bad Name', machineId: '', cronExpr: '0 9', cronTz: 'Nowhere/Land', actionKind: 'spawn', directory: '', prompt: '', maxRuntime: '10s' });
    expect(validateDraft(d)).toEqual({ name: 'name', machineId: 'machine', cronExpr: 'cron', cronTz: 'tz', directory: 'directory', prompt: 'prompt', maxRuntime: 'maxRuntime' });
    expect(validateDraft(emptyDraft({ name: 'x', machineId: 'm', triggerKind: 'interval', intervalEvery: '30s', actionKind: 'script', scriptCommand: 'bad "q' }))).toEqual({ intervalEvery: 'interval', scriptCommand: 'script' });
    expect(validateDraft(emptyDraft({ name: 'x', machineId: 'm', triggerKind: 'once', onceAt: '', actionKind: 'send', sendSessionId: '', prompt: 'p' }))).toEqual({ onceAt: 'once', sendSessionId: 'session' });
    expect(buildCreate(d).ok).toBe(false);
  });
});

describe('fireSnippets', () => {
  it('names the automation in every snippet', () => {
    const s = fireSnippets('tanka-dm');
    expect(s.cli).toBe('very-happy auto fire tanka-dm');
    expect(s.cliPayload).toContain('--payload-json');
    expect(s.cliPayload).toContain('--dedupe-key');
    expect(s.mcp.startsWith('automation_fire({ name: "tanka-dm"')).toBe(true);
  });
});
