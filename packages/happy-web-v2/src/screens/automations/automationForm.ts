/**
 * B-498: the create / edit form as data — a flat `AutomationDraft` the inputs
 * bind to, `draftFromAutomation` to open an existing one, `buildCreate` /
 * `buildUpdate` to turn a draft into the wire body (validated with the wire
 * zod schemas so the server never sees a shape the CLI would refuse), and the
 * field-level validation the form shows before submit. Pure, unit-tested.
 */
import {
  AUTOMATION_MAX_INTERVAL_MS,
  AUTOMATION_MIN_INTERVAL_MS,
  AUTOMATION_NAME_PATTERN,
  AutomationCreateSchema,
  AutomationUpdateSchema,
  type Automation,
  type AutomationAction,
  type AutomationCreate,
  type AutomationTrigger,
  type AutomationUpdate,
} from '@slopus/happy-wire';
import { describeCron } from './automationPresentation';

export const TRIGGER_KINDS = ['cron', 'interval', 'once', 'manual'] as const;
export const ACTION_KINDS = ['spawn', 'send', 'script'] as const;
/** mirrors the CLI's SPAWN_AGENTS / ALLOWED_SPAWN_PERMISSION_MODES (the daemon is the enforcer) */
export const SPAWN_AGENTS = ['claude', 'codex', 'pi', 'gemini', 'openclaw'] as const;
export const SPAWN_PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan', 'yolo', 'bypassPermissions'] as const;

export interface AutomationDraft {
  name: string;
  description: string;
  machineId: string;
  triggerKind: (typeof TRIGGER_KINDS)[number];
  cronExpr: string;
  cronTz: string;
  /** "5m", "1h30m", "2d" — see parseDuration */
  intervalEvery: string;
  /** datetime-local value in the browser's zone */
  onceAt: string;
  actionKind: (typeof ACTION_KINDS)[number];
  agent: string;
  directory: string;
  model: string;
  permissionMode: string;
  worktree: boolean;
  stickyKey: string;
  prompt: string;
  sendSessionId: string;
  /** one shell-ish line; see splitArgv */
  scriptCommand: string;
  scriptCwd: string;
  concurrency: 'skip' | 'queue';
  /** "6h", "30m" */
  maxRuntime: string;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function emptyDraft(over: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    name: '',
    description: '',
    machineId: '',
    triggerKind: 'cron',
    cronExpr: '0 9 * * 1-5',
    cronTz: localTimeZone(),
    intervalEvery: '15m',
    onceAt: '',
    actionKind: 'spawn',
    agent: 'claude',
    directory: '',
    model: '',
    permissionMode: '',
    worktree: false,
    stickyKey: '',
    prompt: '',
    sendSessionId: '',
    scriptCommand: '',
    scriptCwd: '',
    concurrency: 'skip',
    maxRuntime: '',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// durations

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** "5m" / "1h30m" / "2d" / "90" (minutes) → ms; null when unparseable */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * UNIT_MS.m;
  const re = /(\d+(?:\.\d+)?)([dhms])/g;
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * UNIT_MS[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.length || total <= 0) return null;
  return Math.round(total);
}

/** ms → the shortest "1h30m" form parseDuration accepts back */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  const parts: string[] = [];
  let rest = ms;
  for (const [u, size] of [['d', UNIT_MS.d], ['h', UNIT_MS.h], ['m', UNIT_MS.m], ['s', UNIT_MS.s]] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${u}`);
      rest -= n * size;
    }
  }
  return parts.join('') || '0s';
}

// ---------------------------------------------------------------------------
// datetime-local ↔ epoch (browser zone)

const pad = (n: number) => String(n).padStart(2, '0');

export function epochToLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

// ---------------------------------------------------------------------------
// argv

/** Splits one line into argv the way a POSIX shell tokenises words: spaces
 *  separate, '…' and "…" group (with \" escapes inside double quotes). No
 *  expansion of any kind — the daemon runs argv without a shell. */
export function splitArgv(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && i + 1 < line.length && '"\\'.includes(line[i + 1])) {
        cur += line[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        out.push(cur);
        cur = '';
        inWord = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return null; // unterminated quote
  if (inWord) out.push(cur);
  return out;
}

export function joinArgv(argv: string[]): string {
  return argv.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

// ---------------------------------------------------------------------------
// time zones

export function isValidTimeZone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function knownTimeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

/** five fields / @alias; the server is the authority (400 invalid_cron) but
 *  catching the obvious shapes before submit saves a round trip */
export function cronLooksValid(expr: string): boolean {
  const s = expr.trim();
  if (/^@(hourly|daily|midnight|weekly|monthly|yearly|annually)$/i.test(s)) return true;
  const fields = s.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => /^[0-9a-z*,\-/]+$/i.test(f));
}

// ---------------------------------------------------------------------------
// draft ↔ wire

export function draftFromAutomation(a: Automation): AutomationDraft {
  const d = emptyDraft({
    name: a.name,
    description: a.description ?? '',
    machineId: a.machineId,
    concurrency: a.concurrency,
    maxRuntime: formatDuration(a.maxRuntimeMs),
  });
  const t = a.trigger;
  d.triggerKind = t.kind;
  if (t.kind === 'cron') {
    d.cronExpr = t.expr;
    d.cronTz = t.tz;
  } else if (t.kind === 'interval') {
    d.intervalEvery = formatDuration(t.everyMs);
  } else if (t.kind === 'once') {
    d.onceAt = epochToLocalInput(t.at);
  }
  const act = a.action;
  d.actionKind = act.kind;
  if (act.kind === 'spawn') {
    d.agent = act.agent;
    d.directory = act.directory;
    d.model = act.model ?? '';
    d.permissionMode = act.permissionMode ?? '';
    d.worktree = act.worktree === true;
    d.stickyKey = act.sticky?.key ?? '';
    d.prompt = act.prompt;
  } else if (act.kind === 'send') {
    d.sendSessionId = act.sessionId;
    d.prompt = act.prompt;
  } else {
    d.scriptCommand = joinArgv(act.command);
    d.scriptCwd = act.cwd ?? '';
  }
  return d;
}

export type DraftField = keyof AutomationDraft;
export type DraftErrors = Partial<Record<DraftField, string>>;

/** Field problems as error KEYS (the form maps them to `t()`), so the pure
 *  module stays language-free. */
export function validateDraft(d: AutomationDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!AUTOMATION_NAME_PATTERN.test(d.name.trim())) e.name = 'name';
  if (!d.machineId) e.machineId = 'machine';
  if (d.triggerKind === 'cron') {
    if (!cronLooksValid(d.cronExpr)) e.cronExpr = 'cron';
    if (!isValidTimeZone(d.cronTz)) e.cronTz = 'tz';
  } else if (d.triggerKind === 'interval') {
    const ms = parseDuration(d.intervalEvery);
    if (ms === null || ms < AUTOMATION_MIN_INTERVAL_MS || ms > AUTOMATION_MAX_INTERVAL_MS) e.intervalEvery = 'interval';
  } else if (d.triggerKind === 'once') {
    if (localInputToEpoch(d.onceAt) === null) e.onceAt = 'once';
  }
  if (d.actionKind === 'spawn') {
    if (!d.agent.trim()) e.agent = 'agent';
    if (!d.directory.trim()) e.directory = 'directory';
    if (!d.prompt.trim()) e.prompt = 'prompt';
  } else if (d.actionKind === 'send') {
    if (!d.sendSessionId.trim()) e.sendSessionId = 'session';
    if (!d.prompt.trim()) e.prompt = 'prompt';
  } else {
    const argv = splitArgv(d.scriptCommand);
    if (!argv || argv.length === 0) e.scriptCommand = 'script';
  }
  if (d.maxRuntime.trim()) {
    const ms = parseDuration(d.maxRuntime);
    if (ms === null || ms < 60_000 || ms > 7 * 86_400_000) e.maxRuntime = 'maxRuntime';
  }
  return e;
}

export function triggerFromDraft(d: AutomationDraft): AutomationTrigger {
  switch (d.triggerKind) {
    case 'cron':
      return { kind: 'cron', expr: d.cronExpr.trim(), tz: d.cronTz.trim() };
    case 'interval':
      return { kind: 'interval', everyMs: parseDuration(d.intervalEvery) ?? 0 };
    case 'once':
      return { kind: 'once', at: localInputToEpoch(d.onceAt) ?? 0 };
    case 'manual':
    default:
      return { kind: 'manual' };
  }
}

export function actionFromDraft(d: AutomationDraft): AutomationAction {
  switch (d.actionKind) {
    case 'spawn':
      return {
        kind: 'spawn',
        agent: d.agent.trim(),
        directory: d.directory.trim(),
        prompt: d.prompt,
        ...(d.model.trim() ? { model: d.model.trim() } : {}),
        ...(d.permissionMode ? { permissionMode: d.permissionMode } : {}),
        ...(d.worktree ? { worktree: true } : {}),
        ...(d.stickyKey.trim() ? { sticky: { key: d.stickyKey.trim() } } : {}),
      };
    case 'send':
      return { kind: 'send', sessionId: d.sendSessionId.trim(), prompt: d.prompt };
    case 'script':
    default:
      return {
        kind: 'script',
        command: splitArgv(d.scriptCommand) ?? [],
        ...(d.scriptCwd.trim() ? { cwd: d.scriptCwd.trim() } : {}),
      };
  }
}

export type BuildResult<T> = { ok: true; body: T } | { ok: false; errors: DraftErrors };

export function buildCreate(d: AutomationDraft): BuildResult<AutomationCreate> {
  const errors = validateDraft(d);
  if (Object.keys(errors).length) return { ok: false, errors };
  const maxRuntimeMs = d.maxRuntime.trim() ? parseDuration(d.maxRuntime) : null;
  const body: AutomationCreate = {
    name: d.name.trim(),
    machineId: d.machineId,
    trigger: triggerFromDraft(d),
    action: actionFromDraft(d),
    concurrency: d.concurrency,
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(maxRuntimeMs ? { maxRuntimeMs } : {}),
  };
  const parsed = AutomationCreateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: { name: 'schema' } };
  return { ok: true, body: parsed.data };
}

/** Only the fields that differ from `current` go into the PATCH (plus the
 *  version CAS); an unchanged form yields an empty diff. */
export function buildUpdate(d: AutomationDraft, current: Automation): BuildResult<AutomationUpdate> & { changed?: boolean } {
  const errors = validateDraft(d);
  if (Object.keys(errors).length) return { ok: false, errors };
  const body: AutomationUpdate = { version: current.version };
  const name = d.name.trim();
  if (name !== current.name) body.name = name;
  const description = d.description.trim() || null;
  if (description !== (current.description ?? null)) body.description = description;
  if (d.machineId !== current.machineId) body.machineId = d.machineId;
  const trigger = triggerFromDraft(d);
  if (!sameTrigger(trigger, current.trigger)) body.trigger = trigger;
  const action = actionFromDraft(d);
  if (JSON.stringify(action) !== JSON.stringify(current.action)) body.action = action;
  if (d.concurrency !== current.concurrency) body.concurrency = d.concurrency;
  const maxRuntimeMs = d.maxRuntime.trim() ? parseDuration(d.maxRuntime) : null;
  if (maxRuntimeMs && maxRuntimeMs !== current.maxRuntimeMs) body.maxRuntimeMs = maxRuntimeMs;
  const parsed = AutomationUpdateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, errors: { name: 'schema' } };
  return { ok: true, body: parsed.data, changed: Object.keys(body).length > 1 };
}

function sameTrigger(a: AutomationTrigger, b: AutomationTrigger): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'cron' && b.kind === 'cron') return a.expr === b.expr && a.tz === b.tz;
  if (a.kind === 'interval' && b.kind === 'interval') return a.everyMs === b.everyMs; // anchorAt is server-owned
  if (a.kind === 'once' && b.kind === 'once') return a.at === b.at;
  return true;
}

/** live preview under the cron field: worded, or null when not describable */
export function cronPreview(expr: string, tz: string, lang: 'zh' | 'en'): string | null {
  if (!cronLooksValid(expr)) return null;
  const worded = describeCron(expr, lang);
  return worded ? `${worded} · ${tz}` : null;
}

// ---------------------------------------------------------------------------
// how to fire a manual (event) automation — shown on the detail page

export function fireSnippets(name: string): { cli: string; cliPayload: string; mcp: string } {
  return {
    cli: `very-happy auto fire ${name}`,
    cliPayload: `very-happy auto fire ${name} --payload-json '{"key":"value"}' --dedupe-key <event-id>`,
    mcp: `automation_fire({ name: "${name}", payload: "{\\"key\\":\\"value\\"}", dedupeKey: "<event-id>" })`,
  };
}
