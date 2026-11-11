import type { AutomationCreate } from './automations';
import { DEFAULT_QUIET_HOURS, parseMainAgentQuietHours, type MainAgentQuietHours } from './mainAgentSafety';

// B-924 the main agent's default automations (specs/2026-11-main-agent.md §8)
// and its quiet hours. One definition for the CLI (`very-happy main-agent
// automations`) and the Web (Settings → Main agent): an automation is "on"
// when it exists and is active; switching it off pauses it, never deletes it.
//
// Each one targets the main agent (`send` + `target: 'main-agent'`, resolved by
// the server at run time) behind a precheck that costs no tokens: the
// `very-happy main-agent precheck <kind>` command exits non-zero when nothing
// changed, so the run is recorded `skipped` and the main agent is not woken.
// Nothing here closes, archives or wraps up a session by itself.

export const MAIN_AGENT_AUTOMATION_KINDS = ['brief', 'stuck', 'wrapup'] as const;
export type MainAgentAutomationKind = typeof MAIN_AGENT_AUTOMATION_KINDS[number];

export const MAIN_AGENT_AUTOMATION_NAMES: Readonly<Record<MainAgentAutomationKind, string>> = {
    brief: 'main-agent-brief',
    stuck: 'main-agent-stuck',
    wrapup: 'main-agent-wrapup',
};

export function mainAgentAutomationKindOf(name: string): MainAgentAutomationKind | null {
    for (const kind of MAIN_AGENT_AUTOMATION_KINDS) if (MAIN_AGENT_AUTOMATION_NAMES[kind] === name) return kind;
    return null;
}

/** Which ones are on after the first install (all three: the wrap-up one only posts a checklist card). */
export const MAIN_AGENT_AUTOMATION_DEFAULT_ON: Readonly<Record<MainAgentAutomationKind, boolean>> = { brief: true, stuck: true, wrapup: true };

/** Board card keys the default automations post under (one card per day / session / evening). */
export const MAIN_AGENT_CARD_KEY = { brief: 'main-agent-brief:', stuck: 'main-agent-stuck:', wrapup: 'main-agent-wrapup:' } as const;

/** Thresholds the prechecks use (hours). */
export const MAIN_AGENT_STUCK_SILENT_HOURS = 3;
export const MAIN_AGENT_WRAPUP_IDLE_HOURS = 12;

const PRECHECK_TIMEOUT_MS = 120_000;

const PROMPTS: Readonly<Record<MainAgentAutomationKind, string>> = {
    brief: [
        'Morning brief for the owner. The precheck output below is a snapshot (Lead boards, sessions stopped on an API error or silent, tasks waiting for acceptance, failed automations, sessions that could be wrapped up); fill a gap with boards_read / teams_list / owner_board_list only if it says something is missing.',
        'Post exactly ONE card: owner_board_post kind=report, key="main-agent-brief:{{run.id}}", notify=true, title "早报 · <today\'s date>", body in the owner\'s language with these sections when non-empty: 进展（每个团队一行）, 等你决定 / 待验收, 卡住的会话, 失败的自动化, 可以收尾的会话. At most 40 lines, ids as links where you have them.',
        'Do not act on anything in the brief (no sends, no wrap-ups). Then automation_report status=done with a one-line summary.',
    ].join('\n'),
    stuck: [
        'Sessions that look stuck (precheck output below: each line has the session id, title and why — it ended on a model API error, or has been silent for hours in the middle of work).',
        'For each one post a decision card: owner_board_post kind=decision, key="main-agent-stuck:<sessionId>", title "卡住了 · <title>", body = the reason in one or two lines, options [{id:"resume",label:"发「继续」"},{id:"look",label:"我自己看"},{id:"ignore",label:"不用管"}]. Do NOT send anything to those sessions now: only after the owner chooses "resume" on a card, send 继续 to that session (session_send, risk none).',
        'Then automation_report status=done with how many cards you posted.',
    ].join('\n'),
    wrapup: [
        'Sessions that could be wrapped up (precheck output below: id, title, idle time). Call wrapup_suggest once with all of them (sessionId + a one-line reason each, in the owner\'s language): it posts one checklist card. Never call session_wrapup for them yourself — nothing is wrapped up unless the owner ticks it on the card.',
        'When the owner later chooses 收尾所选 on that card you will get a message: then call wrapup_selected with the card id, which wraps up only the ticked sessions.',
        'Then automation_report status=done.',
    ].join('\n'),
};

export interface MainAgentAutomationSpec {
    kind: MainAgentAutomationKind;
    name: string;
    description: string;
}
export const MAIN_AGENT_AUTOMATION_DESCRIPTIONS: Readonly<Record<MainAgentAutomationKind, string>> = {
    brief: 'Main agent: morning brief on the board at 09:00 (pushed).',
    stuck: 'Main agent: every hour, a card for each session that stopped on an API error or went silent (skipped when nothing changed).',
    wrapup: 'Main agent: every evening, one checklist card of sessions you could wrap up; only the ones you tick are wrapped up.',
};

/** The create body of one default automation for `machineId` (the main agent's machine) in IANA zone `tz`. */
export function mainAgentAutomationCreate(kind: MainAgentAutomationKind, input: { machineId: string; tz: string; active?: boolean }): AutomationCreate {
    const trigger: AutomationCreate['trigger'] = kind === 'brief' ? { kind: 'cron', expr: '0 9 * * *', tz: input.tz }
        : kind === 'stuck' ? { kind: 'interval', everyMs: 60 * 60_000 }
        : { kind: 'cron', expr: '30 23 * * *', tz: input.tz };
    return {
        name: MAIN_AGENT_AUTOMATION_NAMES[kind],
        description: MAIN_AGENT_AUTOMATION_DESCRIPTIONS[kind],
        machineId: input.machineId,
        trigger,
        action: { kind: 'send', target: 'main-agent', prompt: PROMPTS[kind] },
        precheck: { command: ['very-happy', 'main-agent', 'precheck', kind, '--record'], timeoutMs: PRECHECK_TIMEOUT_MS, includeOutput: true },
        concurrency: 'skip',
        status: (input.active ?? MAIN_AGENT_AUTOMATION_DEFAULT_ON[kind]) ? 'active' : 'paused',
    };
}

// ─── Quiet hours (KV `vh.main-agent-config.v1`.quietHours) ───────────────────

/**
 * During quiet hours a card the main agent posts goes on the board but is not
 * pushed. The shape and lenient reading are B-922's `parseMainAgentQuietHours`
 * (default on, 00:30–08:30; `tz: null` = the main agent machine's local time).
 * The server cannot know that zone, so a null zone means "nothing to check";
 * the daemon writes its zone on first install and the Web the one it shows.
 */
export type MainAgentQuietWindow = MainAgentQuietHours;
export const MAIN_AGENT_QUIET_HOURS_DEFAULT: Omit<MainAgentQuietWindow, 'tz'> = { enabled: DEFAULT_QUIET_HOURS.enabled, start: DEFAULT_QUIET_HOURS.start, end: DEFAULT_QUIET_HOURS.end };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The config's `quietHours` read with `parseMainAgentQuietHours`; a missing / unknown zone falls back to `fallbackTz` (else null). */
export function readMainAgentQuietHours(config: unknown, fallbackTz: string | null = null): MainAgentQuietWindow {
    const raw = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>).quietHours : undefined;
    const q = parseMainAgentQuietHours(raw);
    return { ...q, tz: isValidTimeZone(q.tz) ? q.tz : isValidTimeZone(fallbackTz) ? fallbackTz : null };
}

/** Whether `now` falls inside the window (start inclusive, end exclusive; start === end = never). */
export function isMainAgentQuietTime(quiet: MainAgentQuietWindow, now: number): boolean {
    if (!quiet.enabled || !quiet.tz) return false;
    const toMin = (v: string) => { const m = HHMM.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
    const start = toMin(quiet.start);
    const end = toMin(quiet.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    let minute: number;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now));
        minute = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value);
    } catch { return false; }
    if (!Number.isFinite(minute)) return false;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The config with its quiet hours written out in `tz` when it has none or they have no zone; null when nothing to add. */
export function withDefaultQuietHours(config: unknown, tz: string): Record<string, unknown> | null {
    const base = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
    const current = base.quietHours;
    if (current && typeof current === 'object' && !Array.isArray(current)) {
        if (isValidTimeZone((current as Record<string, unknown>).tz)) return null;
        return { ...base, quietHours: { ...readMainAgentQuietHours(base), tz } };
    }
    return { ...base, quietHours: { ...MAIN_AGENT_QUIET_HOURS_DEFAULT, tz } };
}
