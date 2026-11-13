/**
 * B-924 — pure logic behind Settings → Main agent → default automations and
 * quiet hours (MainAgentAutomationsSection). One definition of the three
 * automations lives in happy-wire (`mainAgentAutomationCreate`); here we only
 * decide what a switch does:
 *   on  = it exists and is active;
 *   off → on  = resume it, or create it on the main agent's machine when absent;
 *   on  → off = pause it (never delete).
 * Quiet hours sit in KV `vh.main-agent-config.v1`.quietHours; a write keeps
 * every other field of that blob.
 */
import {
    MAIN_AGENT_AUTOMATION_KINDS,
    MAIN_AGENT_AUTOMATION_NAMES,
    mainAgentAutomationCreate,
    readMainAgentQuietHours,
    type Automation,
    type AutomationCreate,
    type AutomationUpdate,
    type MainAgentAutomationKind,
    type MainAgentQuietWindow,
} from '@slopus/happy-wire';

export interface MainAgentAutomationRow {
    kind: MainAgentAutomationKind;
    automation: Automation | null;
    on: boolean;
}

/** The three default automations, matched by name, in a fixed order. */
export function mainAgentAutomationRows(automations: readonly Automation[]): MainAgentAutomationRow[] {
    return MAIN_AGENT_AUTOMATION_KINDS.map((kind) => {
        const automation = automations.find((a) => a.name === MAIN_AGENT_AUTOMATION_NAMES[kind]) ?? null;
        return { kind, automation, on: automation?.status === 'active' };
    });
}

export type MainAgentTogglePlan =
    | { op: 'noop' }
    | { op: 'pause'; id: string }
    | { op: 'resume'; id: string }
    | { op: 'create'; body: AutomationCreate }
    /** absent and no main agent machine to create it on */
    | { op: 'needMainAgent' };

export function planMainAgentToggle(row: MainAgentAutomationRow, on: boolean, input: { machineId: string | null; tz: string }): MainAgentTogglePlan {
    if (on === row.on) return { op: 'noop' };
    if (!on) return row.automation ? { op: 'pause', id: row.automation.id } : { op: 'noop' };
    if (row.automation) return { op: 'resume', id: row.automation.id };
    if (!input.machineId) return { op: 'needMainAgent' };
    return { op: 'create', body: mainAgentAutomationCreate(row.kind, { machineId: input.machineId, tz: input.tz, active: true }) };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isHhmm(v: string): boolean {
    return HHMM.test(v);
}

export { readMainAgentQuietHours };

/** The config blob with `quietHours` replaced; every other field is kept. */
export function withQuietHours(previous: unknown, quiet: MainAgentQuietWindow, now: number): Record<string, unknown> {
    const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...(previous as Record<string, unknown>) } : {};
    return { ...base, v: 1, quietHours: { enabled: quiet.enabled, start: quiet.start, end: quiet.end, tz: quiet.tz }, updatedAt: now };
}

/**
 * The zone the main agent runs on, as Settings shows it: the quiet hours' zone,
 * else the brief's / wrap-up's cron zone, else this browser's.
 */
export function mainAgentZone(quietTz: string | null, rows: readonly MainAgentAutomationRow[], browserTz: string): string {
    if (quietTz) return quietTz;
    for (const row of rows) if (row.automation?.trigger.kind === 'cron') return row.automation.trigger.tz;
    return browserTz;
}

/** Changing the zone: the cron automations (brief 09:00, wrap-up 23:30) that run in another zone get it too. */
export function planZoneChange(rows: readonly MainAgentAutomationRow[], tz: string): Array<{ id: string; body: AutomationUpdate }> {
    const out: Array<{ id: string; body: AutomationUpdate }> = [];
    for (const row of rows) {
        const a = row.automation;
        if (a?.trigger.kind !== 'cron' || a.trigger.tz === tz) continue;
        out.push({ id: a.id, body: { version: a.version, trigger: { ...a.trigger, tz } } });
    }
    return out;
}

/** 恢复默认自动化: create the missing ones (on) on the main agent's machine; existing ones are left as they are. */
export function planRestoreDefaults(rows: readonly MainAgentAutomationRow[], input: { machineId: string | null; tz: string }): { op: 'create'; bodies: AutomationCreate[] } | { op: 'noop' } | { op: 'needMainAgent' } {
    const missing = rows.filter((r) => !r.automation);
    if (!missing.length) return { op: 'noop' };
    if (!input.machineId) return { op: 'needMainAgent' };
    return { op: 'create', bodies: missing.map((r) => mainAgentAutomationCreate(r.kind, { machineId: input.machineId!, tz: input.tz, active: true })) };
}
