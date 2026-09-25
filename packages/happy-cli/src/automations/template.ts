/**
 * Pure helpers for B-496 Automations: prompt / sticky-key templates and the
 * CLI's duration + trigger + action parsing. No IO; unit-tested.
 *
 * Templates: `{{payload}}` (raw payload text), `{{payload.a.b}}` (JSON path
 * into a JSON payload; empty when the payload is not JSON or the path is
 * missing), `{{run.id}}`, `{{automation.name}}`, `{{now}}` (ISO, in the
 * automation's zone when it has one). Unknown placeholders stay verbatim so a
 * prompt that legitimately talks about `{{foo}}` is not mangled.
 */

import type { AutomationAction, AutomationTrigger } from '@slopus/happy-wire';

export interface TemplateContext {
    payload?: string | null;
    runId: string;
    automationName: string;
    /** IANA zone for `{{now}}`; absent = UTC. */
    tz?: string;
    now?: number;
}

function payloadJson(payload: string | null | undefined): unknown {
    if (!payload) return undefined;
    try { return JSON.parse(payload); } catch { return undefined; }
}

function lookupPath(root: unknown, path: string[]): unknown {
    let current: unknown = root;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

function scalar(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value); } catch { return ''; }
}

export function formatNow(now: number, tz?: string): string {
    if (!tz) return new Date(now).toISOString();
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' }).formatToParts(new Date(now));
        const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
        const offset = get('timeZoneName').replace(/^GMT$/, '+00:00').replace(/^GMT/, '');
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset || 'Z'}`;
    } catch { return new Date(now).toISOString(); }
}

export function renderTemplate(text: string, context: TemplateContext): string {
    const json = payloadJson(context.payload);
    return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (whole, name: string) => {
        if (name === 'payload') return context.payload ?? '';
        if (name.startsWith('payload.')) return scalar(lookupPath(json, name.slice('payload.'.length).split('.')));
        if (name === 'run.id') return context.runId;
        if (name === 'automation.name') return context.automationName;
        if (name === 'now') return formatNow(context.now ?? Date.now(), context.tz);
        return whole;
    });
}

/** Render every user-facing string of an action; sticky key is rendered separately by the caller. */
export function renderAction(action: AutomationAction, context: TemplateContext): AutomationAction {
    const r = (value: string) => renderTemplate(value, context);
    if (action.kind === 'spawn') return { ...action, prompt: r(action.prompt) };
    if (action.kind === 'send') return { ...action, prompt: r(action.prompt) };
    return { ...action, command: action.command.map(r), ...(action.env ? { env: Object.fromEntries(Object.entries(action.env).map(([k, v]) => [k, r(v)])) } : {}) };
}

/** Cut to at most `maxChars` characters, keeping the tail (for logs) or the head (for summaries). */
export function clipText(text: string, maxChars: number, keep: 'head' | 'tail' = 'head'): string {
    if (text.length <= maxChars) return text;
    return keep === 'head' ? text.slice(0, maxChars) : text.slice(text.length - maxChars);
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** `90s`, `5m`, `1h30m`, `2d`; a bare number is milliseconds. */
export function parseDuration(raw: string): number {
    const text = raw.trim();
    if (/^\d+$/.test(text)) return Number(text);
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
    let total = 0; let matched = 0; let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { total += Number(m[1]) * DURATION_UNITS[m[2]]; matched++; last = re.lastIndex; }
    if (matched === 0 || last !== text.length) throw new Error(`Invalid duration: ${raw} (use e.g. 90s, 5m, 1h30m, 2d)`);
    return Math.round(total);
}

export function formatDuration(ms: number): string {
    if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
}

export interface TriggerFlags { cron?: string; tz?: string; every?: string; at?: string; manual?: boolean }
/** Exactly one trigger flag group; returns undefined when none was given (edit keeps the old trigger). */
export function triggerFromFlags(flags: TriggerFlags, now: number = Date.now()): AutomationTrigger | undefined {
    const given = [flags.cron !== undefined, flags.every !== undefined, flags.at !== undefined, flags.manual === true].filter(Boolean).length;
    if (given === 0) { if (flags.tz !== undefined) throw new Error('--tz only applies with --cron'); return undefined; }
    if (given > 1) throw new Error('Use exactly one of --cron, --every, --at, --manual');
    if (flags.cron !== undefined) {
        if (!flags.tz) throw new Error('--cron requires --tz <IANA zone> (e.g. Asia/Singapore)');
        return { kind: 'cron', expr: flags.cron, tz: flags.tz };
    }
    if (flags.tz !== undefined) throw new Error('--tz only applies with --cron');
    if (flags.every !== undefined) return { kind: 'interval', everyMs: parseDuration(flags.every), anchorAt: now };
    if (flags.at !== undefined) {
        const at = Date.parse(flags.at);
        if (!Number.isFinite(at)) throw new Error(`--at must be an ISO 8601 timestamp, got: ${flags.at}`);
        return { kind: 'once', at };
    }
    return { kind: 'manual' };
}

export function describeTrigger(trigger: AutomationTrigger): string {
    switch (trigger.kind) {
        case 'cron': return `cron ${trigger.expr} (${trigger.tz})`;
        case 'interval': return `every ${formatDuration(trigger.everyMs)}`;
        case 'once': return `once at ${new Date(trigger.at).toISOString()}`;
        default: return 'manual';
    }
}

export function describeAction(action: AutomationAction): string {
    if (action.kind === 'spawn') return `spawn ${action.agent} in ${action.directory}${action.sticky ? ` (sticky ${action.sticky.key})` : ''}`;
    if (action.kind === 'send') return `send to session ${action.sessionId}`;
    return `script ${action.command.join(' ')}`;
}
