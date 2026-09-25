/**
 * B-498: pure presentation logic for the Automations views — trigger wording,
 * run status tone, attention ordering, action summaries. No React, no store,
 * no `t()`: the two languages the product ships (zh / en) are branched here so
 * the module stays unit-testable and the wording of a cron line is pinned.
 */
import type { Automation, AutomationAction, AutomationRun, AutomationRunStatus, AutomationTrigger } from '@slopus/happy-wire';

export type Lang = 'zh' | 'en';
export function langOf(lang: string): Lang {
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

// ---------------------------------------------------------------------------
// triggers

const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MON_EN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Expands one cron field into a sorted list of ints, or null when it is a
 *  wildcard/step we describe differently, or undefined when unsupported. */
function expandList(field: string, min: number, max: number, names?: Record<string, number>): number[] | undefined {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^([a-z0-9]+)(?:-([a-z0-9]+))?$/i.exec(part.trim());
    if (!m) return undefined;
    const parse = (s: string) => (names && names[s.toLowerCase()] !== undefined ? names[s.toLowerCase()] : /^\d+$/.test(s) ? Number(s) : NaN);
    const a = parse(m[1]);
    const b = m[2] === undefined ? a : parse(m[2]);
    if (Number.isNaN(a) || Number.isNaN(b) || a < min || b > max || a > b) return undefined;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

function joinList(items: string[], lang: Lang): string {
  return items.join(lang === 'zh' ? '、' : ', ');
}

function timesOf(minutes: number[], hours: number[]): string[] {
  const times: string[] = [];
  for (const h of hours) for (const m of minutes) times.push(`${pad2(h)}:${pad2(m)}`);
  return times;
}

function dowPhrase(days: number[], lang: Lang): string {
  const norm = [...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  const key = norm.join(',');
  if (key === '1,2,3,4,5') return lang === 'zh' ? '工作日' : 'weekdays';
  if (key === '0,6') return lang === 'zh' ? '周末' : 'weekends';
  if (key === '0,1,2,3,4,5,6') return lang === 'zh' ? '每天' : 'every day';
  return joinList(norm.map((d) => (lang === 'zh' ? DOW_ZH[d] : DOW_EN[d])), lang);
}

/**
 * Human wording for a five-field cron expression. Returns null for shapes it
 * does not recognise (the caller shows the raw expression instead) — better an
 * honest raw `17 3 <star>/2 * *` than a wrong sentence.
 */
export function describeCron(input: string, lang: Lang): string | null {
  const expr = CRON_ALIASES[input.trim().toLowerCase()] ?? input.trim();
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  const zh = lang === 'zh';

  // every minute / every N minutes
  if (hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    if (minF === '*') return zh ? '每分钟' : 'Every minute';
    const step = /^\*\/(\d+)$/.exec(minF);
    if (step) return zh ? `每 ${step[1]} 分钟` : `Every ${step[1]} minutes`;
  }
  const minutes = expandList(minF, 0, 59);
  if (!minutes) return null;

  // hourly / every N hours at :MM
  if (domF === '*' && monF === '*' && dowF === '*') {
    if (hourF === '*') {
      if (minutes.length !== 1) return null;
      return zh ? `每小时 ${pad2(minutes[0])} 分` : `Hourly at :${pad2(minutes[0])}`;
    }
    const step = /^\*\/(\d+)$/.exec(hourF);
    if (step) {
      if (minutes.length !== 1) return null;
      return zh ? `每 ${step[1]} 小时（${pad2(minutes[0])} 分）` : `Every ${step[1]} hours at :${pad2(minutes[0])}`;
    }
  }
  const hours = expandList(hourF, 0, 23);
  if (!hours) return null;
  const times = timesOf(minutes, hours);
  if (times.length > 4) return null;
  const at = joinList(times, lang);

  if (domF === '*' && monF === '*') {
    if (dowF === '*') return zh ? `每天 ${at}` : `Daily at ${at}`;
    const days = expandList(dowF, 0, 7, DOW_NAMES);
    if (!days) return null;
    const phrase = dowPhrase(days, lang);
    return zh ? `${phrase} ${at}` : `${at} on ${phrase}`;
  }
  if (dowF !== '*') return null; // dom AND dow (Vixie OR) — too subtle for a sentence
  const dom = expandList(domF, 1, 31);
  if (!dom || dom.length !== 1) return null;
  if (monF === '*') return zh ? `每月 ${dom[0]} 日 ${at}` : `Monthly on day ${dom[0]} at ${at}`;
  const months = expandList(monF, 1, 12, MON_NAMES);
  if (!months || months.length !== 1) return null;
  return zh ? `每年 ${months[0]} 月 ${dom[0]} 日 ${at}` : `Yearly on ${MON_EN[months[0]]} ${dom[0]} at ${at}`;
}

/** "45s" / "5m" / "2h 5m" / "1d 12h" — compact, mono-friendly */
export function fmtSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || parts.length === 0) parts.push(`${m}m`);
  return parts.slice(0, 2).join(' ');
}

export function describeInterval(everyMs: number, lang: Lang): string {
  return lang === 'zh' ? `每 ${fmtSpan(everyMs)}` : `Every ${fmtSpan(everyMs)}`;
}

export function fmtAbsolute(at: number, lang: Lang, opts?: { tz?: string }): string {
  try {
    return new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      ...(opts?.tz ? { timeZone: opts.tz } : {}),
    });
  } catch {
    return new Date(at).toLocaleString();
  }
}

export interface TriggerText {
  /** the sentence shown in the row */
  summary: string;
  /** raw expression + zone / anchor, for a hover title */
  detail: string;
}

export function describeTrigger(trigger: AutomationTrigger, lang: Lang): TriggerText {
  const zh = lang === 'zh';
  switch (trigger.kind) {
    case 'cron': {
      const worded = describeCron(trigger.expr, lang);
      return {
        summary: worded ? `${worded} · ${trigger.tz}` : `${trigger.expr} · ${trigger.tz}`,
        detail: `cron ${trigger.expr} (${trigger.tz})`,
      };
    }
    case 'interval':
      return {
        summary: describeInterval(trigger.everyMs, lang),
        detail: trigger.anchorAt ? `${zh ? '锚点' : 'anchor'} ${fmtAbsolute(trigger.anchorAt, lang)}` : `${trigger.everyMs}ms`,
      };
    case 'once':
      return {
        summary: zh ? `一次 · ${fmtAbsolute(trigger.at, lang)}` : `Once · ${fmtAbsolute(trigger.at, lang)}`,
        detail: new Date(trigger.at).toISOString(),
      };
    case 'manual':
    default:
      return { summary: zh ? '仅触发器' : 'Trigger only', detail: 'manual' };
  }
}

// ---------------------------------------------------------------------------
// actions

export interface ActionText {
  kind: AutomationAction['kind'];
  /** one line: agent + directory / target session / argv */
  headline: string;
  /** the prompt (first lines) or the full argv, shown mono */
  body: string;
  /** whether `body` was cut */
  truncated: boolean;
}

export function promptPreview(text: string, maxLines = 3, maxChars = 280): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  let truncated = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return { text: out, truncated };
}

export function describeAction(action: AutomationAction, lang: Lang): ActionText {
  const zh = lang === 'zh';
  switch (action.kind) {
    case 'spawn': {
      const bits = [action.agent, action.directory];
      if (action.model) bits.push(action.model);
      if (action.worktree) bits.push('worktree');
      if (action.sticky) bits.push(`sticky ${action.sticky.key}`);
      const p = promptPreview(action.prompt);
      return { kind: 'spawn', headline: bits.join(' · '), body: p.text, truncated: p.truncated };
    }
    case 'send': {
      const p = promptPreview(action.prompt);
      return { kind: 'send', headline: zh ? `发送到会话 ${action.sessionId}` : `Send to session ${action.sessionId}`, body: p.text, truncated: p.truncated };
    }
    case 'script':
    default: {
      const argv = action.command.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
      const p = promptPreview(argv, 3, 400);
      return { kind: 'script', headline: action.cwd ? `${zh ? '目录' : 'cwd'} ${action.cwd}` : (zh ? '脚本' : 'script'), body: p.text, truncated: p.truncated };
    }
  }
}

// ---------------------------------------------------------------------------
// runs

/** Visual tone of a run status. `live` is the only accent use (a run is running). */
export type RunTone = 'wait' | 'live' | 'ok' | 'err' | 'muted';

export function runTone(status: AutomationRunStatus | string): RunTone {
  switch (status) {
    case 'queued':
      return 'wait';
    case 'claimed':
    case 'running':
      return 'live';
    case 'done':
      return 'ok';
    case 'failed':
    case 'expired':
      return 'err';
    case 'skipped':
    case 'cancelled':
    default:
      return 'muted';
  }
}

export function isRunOpen(status: string): boolean {
  return status === 'queued' || status === 'claimed' || status === 'running';
}

/** wall-clock duration of a run: start (or claim) → finish (or `now` while open) */
export function runDurationMs(run: Pick<AutomationRun, 'status' | 'startedAt' | 'claimedAt' | 'finishedAt'>, now: number): number | null {
  const start = run.startedAt ?? run.claimedAt;
  if (!start) return null;
  const end = run.finishedAt ?? (isRunOpen(run.status) ? now : null);
  if (end === null) return null;
  return Math.max(0, end - start);
}

/**
 * Why a run wants the owner. The daemon/server reasons are a small vocabulary
 * (contract-notes); anything else is shown verbatim.
 */
export type AttentionKind =
  | 'needs_input'
  | 'failed'
  | 'expired'
  | 'machine_offline'
  | 'unknown_outcome'
  | 'daemon_restarted'
  | 'invalid_action'
  | 'other';

export function attentionKind(run: Pick<AutomationRun, 'status' | 'attentionReason'>): AttentionKind {
  const reason = run.attentionReason ?? '';
  if (reason === 'needs_input') return 'needs_input';
  if (reason === 'machine_offline') return 'machine_offline';
  if (reason === 'unknown_outcome') return 'unknown_outcome';
  if (reason === 'daemon_restarted') return 'daemon_restarted';
  if (reason === 'invalid_action') return 'invalid_action';
  if (reason === 'lease_expired' || reason === 'max_runtime_exceeded' || run.status === 'expired') return 'expired';
  if (run.status === 'failed') return 'failed';
  return 'other';
}

/**
 * Attention ordering: what the owner can act on NOW comes first —
 *  0 an agent is waiting for input (live, blocks a session),
 *  1 something ended badly (failed / expired / unknown outcome / rejected),
 *  2 nobody picked the run up (machine offline — informational until the
 *    machine is back),
 *  3 anything else.
 * Inside a rank: newest activity first.
 */
export function attentionRank(run: Pick<AutomationRun, 'status' | 'attentionReason'>): number {
  switch (attentionKind(run)) {
    case 'needs_input':
      return 0;
    case 'failed':
    case 'expired':
    case 'unknown_outcome':
    case 'daemon_restarted':
    case 'invalid_action':
      return 1;
    case 'machine_offline':
      return 2;
    default:
      return 3;
  }
}

export function sortAttentionRuns<T extends Pick<AutomationRun, 'status' | 'attentionReason' | 'updatedAt' | 'needsAttention'>>(runs: T[]): T[] {
  return runs
    .filter((r) => r.needsAttention)
    .slice()
    .sort((a, b) => attentionRank(a) - attentionRank(b) || b.updatedAt - a.updatedAt);
}

/** "5m ago" / "in 2h" — the board's compact vocabulary, both directions */
export function fmtRelative(at: number, now: number, lang: Lang): string {
  const diff = at - now;
  const span = fmtSpan(Math.abs(diff));
  if (Math.abs(diff) < 60_000) return lang === 'zh' ? '现在' : 'now';
  if (lang === 'zh') return diff > 0 ? `${span} 后` : `${span} 前`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** the moment a run row is sorted/labelled by: finish, else start, else creation */
export function runMoment(run: Pick<AutomationRun, 'finishedAt' | 'startedAt' | 'claimedAt' | 'scheduledFor' | 'createdAt'>): number {
  return run.finishedAt ?? run.startedAt ?? run.claimedAt ?? run.scheduledFor ?? run.createdAt;
}

/** list order for the automations page: attention first, then paused last, then by next run */
export function sortAutomations(list: Automation[], attentionByAutomation: Record<string, number>): Automation[] {
  return list.slice().sort((a, b) => {
    const attn = (attentionByAutomation[b.id] ?? 0) - (attentionByAutomation[a.id] ?? 0);
    if (attn) return attn;
    const paused = Number(a.status === 'paused') - Number(b.status === 'paused');
    if (paused) return paused;
    const an = a.nextRunAt ?? Number.POSITIVE_INFINITY;
    const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
    return a.name.localeCompare(b.name);
  });
}
