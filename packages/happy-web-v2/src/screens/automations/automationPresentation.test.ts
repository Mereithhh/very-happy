import { describe, expect, it } from 'vitest';
import type { Automation, AutomationRun } from '@slopus/happy-wire';
import {
  attentionKind,
  attentionRank,
  describeAction,
  describeCron,
  describeInterval,
  describeTrigger,
  fmtRelative,
  fmtSpan,
  isRunOpen,
  langOf,
  promptPreview,
  runDurationMs,
  runTone,
  sortAttentionRuns,
  sortAutomations,
} from './automationPresentation';

function run(over: Partial<AutomationRun>): AutomationRun {
  return {
    id: over.id ?? 'r',
    automationId: 'a',
    automationName: 'daily',
    machineId: 'm',
    source: 'schedule',
    dedupeKey: null,
    payload: null,
    status: 'done',
    needsAttention: true,
    attentionReason: null,
    sessionId: null,
    stickyKey: null,
    scheduledFor: null,
    claimedAt: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    exitCode: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('describeCron', () => {
  it('words the common shapes in both languages', () => {
    expect(describeCron('* * * * *', 'en')).toBe('Every minute');
    expect(describeCron('*/15 * * * *', 'zh')).toBe('每 15 分钟');
    expect(describeCron('30 * * * *', 'en')).toBe('Hourly at :30');
    expect(describeCron('0 */6 * * *', 'en')).toBe('Every 6 hours at :00');
    expect(describeCron('0 9 * * *', 'en')).toBe('Daily at 09:00');
    expect(describeCron('0 9 * * *', 'zh')).toBe('每天 09:00');
    expect(describeCron('0 9,18 * * *', 'en')).toBe('Daily at 09:00, 18:00');
    expect(describeCron('30 18 * * 1-5', 'en')).toBe('18:30 on weekdays');
    expect(describeCron('30 18 * * 1-5', 'zh')).toBe('工作日 18:30');
    expect(describeCron('0 10 * * 0,6', 'zh')).toBe('周末 10:00');
    expect(describeCron('0 9 * * mon,wed', 'en')).toBe('09:00 on Mon, Wed');
    expect(describeCron('0 9 * * 1,3', 'zh')).toBe('周一、周三 09:00');
    expect(describeCron('0 0 1 * *', 'en')).toBe('Monthly on day 1 at 00:00');
    expect(describeCron('15 8 25 12 *', 'en')).toBe('Yearly on Dec 25 at 08:15');
    expect(describeCron('15 8 25 12 *', 'zh')).toBe('每年 12 月 25 日 08:15');
  });
  it('expands the @ aliases', () => {
    expect(describeCron('@hourly', 'en')).toBe('Hourly at :00');
    expect(describeCron('@daily', 'zh')).toBe('每天 00:00');
    expect(describeCron('@weekly', 'en')).toBe('00:00 on Sun');
    expect(describeCron('@monthly', 'en')).toBe('Monthly on day 1 at 00:00');
    expect(describeCron('@yearly', 'en')).toBe('Yearly on Jan 1 at 00:00');
  });
  it('refuses shapes it cannot word honestly', () => {
    expect(describeCron('17 3 */2 * *', 'en')).toBeNull(); // day step
    expect(describeCron('0 9 1 * 1', 'en')).toBeNull(); // dom AND dow (Vixie OR)
    expect(describeCron('0 9 1-3 * *', 'en')).toBeNull(); // several days of month
    expect(describeCron('0,15,30,45 9,10,11 * * *', 'en')).toBeNull(); // 12 times a day
    expect(describeCron('bad', 'en')).toBeNull();
    expect(describeCron('61 9 * * *', 'en')).toBeNull();
  });
});

describe('describeTrigger', () => {
  it('appends the zone to cron and falls back to the raw expression', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, 'en')).toEqual({
      summary: 'Daily at 09:00 · Asia/Singapore',
      detail: 'cron 0 9 * * * (Asia/Singapore)',
    });
    expect(describeTrigger({ kind: 'cron', expr: '17 3 */2 * *', tz: 'UTC' }, 'zh').summary).toBe('17 3 */2 * * · UTC');
  });
  it('words interval / once / manual', () => {
    expect(describeInterval(5 * 60_000, 'en')).toBe('Every 5m');
    expect(describeInterval(90 * 60_000, 'zh')).toBe('每 1h 30m');
    expect(describeTrigger({ kind: 'interval', everyMs: 86_400_000 }, 'en').summary).toBe('Every 1d');
    expect(describeTrigger({ kind: 'manual' }, 'zh')).toEqual({ summary: '仅触发器', detail: 'manual' });
    expect(describeTrigger({ kind: 'manual' }, 'en').summary).toBe('Trigger only');
    const once = describeTrigger({ kind: 'once', at: Date.UTC(2026, 8, 30, 1, 0) }, 'en');
    expect(once.summary.startsWith('Once · ')).toBe(true);
    expect(once.detail).toBe('2026-09-30T01:00:00.000Z');
  });
  it('fmtSpan keeps at most two units', () => {
    expect(fmtSpan(0)).toBe('0s');
    expect(fmtSpan(45_000)).toBe('45s');
    expect(fmtSpan(60_000)).toBe('1m');
    expect(fmtSpan(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(fmtSpan(2 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000)).toBe('2d 3h');
  });
  it('langOf maps zh variants to zh', () => {
    expect(langOf('zh-Hans')).toBe('zh');
    expect(langOf('zh-Hant')).toBe('zh');
    expect(langOf('en')).toBe('en');
    expect(langOf('ja')).toBe('en');
  });
});

describe('describeAction', () => {
  it('summarises spawn with the first prompt lines', () => {
    const text = describeAction(
      { kind: 'spawn', agent: 'claude', directory: '~/work', prompt: 'line1\nline2\nline3\nline4', model: 'opus', worktree: true, sticky: { key: '{{payload.id}}' } },
      'en',
    );
    expect(text).toEqual({ kind: 'spawn', headline: 'claude · ~/work · opus · worktree · sticky {{payload.id}}', body: 'line1\nline2\nline3', truncated: true });
  });
  it('quotes argv pieces that contain spaces', () => {
    const text = describeAction({ kind: 'script', command: ['bash', '-lc', 'echo hi there'], cwd: '/srv' }, 'zh');
    expect(text.headline).toBe('目录 /srv');
    expect(text.body).toBe('bash -lc "echo hi there"');
    expect(text.truncated).toBe(false);
  });
  it('promptPreview cuts by lines and by chars', () => {
    expect(promptPreview('a\r\nb\r\nc', 2)).toEqual({ text: 'a\nb', truncated: true });
    expect(promptPreview('x'.repeat(300), 3, 10)).toEqual({ text: 'x'.repeat(10), truncated: true });
    expect(promptPreview('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('run status', () => {
  it('maps status to tone — accent only while running', () => {
    expect(runTone('queued')).toBe('wait');
    expect(runTone('claimed')).toBe('live');
    expect(runTone('running')).toBe('live');
    expect(runTone('done')).toBe('ok');
    expect(runTone('failed')).toBe('err');
    expect(runTone('expired')).toBe('err');
    expect(runTone('skipped')).toBe('muted');
    expect(runTone('cancelled')).toBe('muted');
    expect(runTone('something_new')).toBe('muted'); // newer server enum → neutral
    expect(isRunOpen('running')).toBe(true);
    expect(isRunOpen('done')).toBe(false);
  });
  it('measures duration from start (or claim) to finish (or now while open)', () => {
    expect(runDurationMs(run({ status: 'done', startedAt: 100, finishedAt: 400 }), 1_000)).toBe(300);
    expect(runDurationMs(run({ status: 'done', claimedAt: 100, finishedAt: 400 }), 1_000)).toBe(300);
    expect(runDurationMs(run({ status: 'running', startedAt: 100 }), 1_000)).toBe(900);
    expect(runDurationMs(run({ status: 'queued' }), 1_000)).toBeNull();
    expect(runDurationMs(run({ status: 'cancelled', claimedAt: 100 }), 1_000)).toBeNull();
  });
  it('classifies attention reasons', () => {
    expect(attentionKind(run({ status: 'running', attentionReason: 'needs_input' }))).toBe('needs_input');
    expect(attentionKind(run({ status: 'queued', attentionReason: 'machine_offline' }))).toBe('machine_offline');
    expect(attentionKind(run({ status: 'expired', attentionReason: 'lease_expired' }))).toBe('expired');
    expect(attentionKind(run({ status: 'expired', attentionReason: 'max_runtime_exceeded' }))).toBe('expired');
    expect(attentionKind(run({ status: 'failed', attentionReason: 'unknown_outcome' }))).toBe('unknown_outcome');
    expect(attentionKind(run({ status: 'failed', attentionReason: 'invalid_action' }))).toBe('invalid_action');
    expect(attentionKind(run({ status: 'failed', attentionReason: 'boom' }))).toBe('failed');
    expect(attentionKind(run({ status: 'done', attentionReason: 'please review' }))).toBe('other');
  });
});

describe('sortAttentionRuns', () => {
  it('puts agent requests first, then failures, then offline machines; newest inside a rank', () => {
    const rows = [
      run({ id: 'offline', status: 'queued', attentionReason: 'machine_offline', updatedAt: 90 }),
      run({ id: 'failed-old', status: 'failed', updatedAt: 10 }),
      run({ id: 'not-attn', status: 'failed', needsAttention: false, updatedAt: 99 }),
      run({ id: 'expired', status: 'expired', attentionReason: 'lease_expired', updatedAt: 20 }),
      run({ id: 'input', status: 'running', attentionReason: 'needs_input', updatedAt: 5 }),
      run({ id: 'other', status: 'done', attentionReason: 'review', updatedAt: 100 }),
    ];
    expect(sortAttentionRuns(rows).map((r) => r.id)).toEqual(['input', 'expired', 'failed-old', 'offline', 'other']);
    expect(attentionRank(run({ status: 'running', attentionReason: 'needs_input' }))).toBe(0);
    expect(attentionRank(run({ status: 'queued', attentionReason: 'machine_offline' }))).toBe(2);
  });
  it('does not mutate the input', () => {
    const rows = [run({ id: 'b', updatedAt: 1 }), run({ id: 'a', updatedAt: 2 })];
    sortAttentionRuns(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('sortAutomations', () => {
  const auto = (id: string, over: Partial<Automation>): Automation => ({
    id,
    name: id,
    description: null,
    machineId: 'm',
    status: 'active',
    trigger: { kind: 'manual' },
    action: { kind: 'script', command: ['true'] },
    concurrency: 'skip',
    maxRuntimeMs: 60_000,
    nextRunAt: null,
    version: 1,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  it('attention first, paused last, then soonest next run, then name', () => {
    const list = [
      auto('zeta', { nextRunAt: 50 }),
      auto('paused', { status: 'paused' }),
      auto('soon', { nextRunAt: 10 }),
      auto('attn', { nextRunAt: 999 }),
      auto('manual', {}),
      auto('alpha', {}),
    ];
    expect(sortAutomations(list, { attn: 2 }).map((a) => a.id)).toEqual(['attn', 'soon', 'zeta', 'alpha', 'manual', 'paused']);
  });
});

describe('fmtRelative', () => {
  it('reads both directions', () => {
    expect(fmtRelative(1_000, 0, 'en')).toBe('now');
    expect(fmtRelative(5 * 60_000, 0, 'en')).toBe('in 5m');
    expect(fmtRelative(0, 5 * 60_000, 'en')).toBe('5m ago');
    expect(fmtRelative(2 * 3_600_000, 0, 'zh')).toBe('2h 后');
    expect(fmtRelative(0, 3 * 86_400_000, 'zh')).toBe('3d 前');
  });
});
