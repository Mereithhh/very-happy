import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_AUTOMATION_NAMES, type Automation } from '@slopus/happy-wire';
import { isHhmm, mainAgentAutomationRows, mainAgentZone, planMainAgentToggle, planRestoreDefaults, planZoneChange, readMainAgentQuietHours, withQuietHours } from './mainAgentAutomationsModel';

const auto = (name: string, status: 'active' | 'paused', id = name): Automation => ({
    id, name, description: null, machineId: 'm1', status,
    trigger: { kind: 'manual' }, action: { kind: 'send', target: 'main-agent', prompt: 'p' },
    concurrency: 'skip', maxRuntimeMs: null, nextRunAt: null, version: 1, lastRunAt: null, lastRunStatus: null, createdAt: 0, updatedAt: 0,
} as unknown as Automation);

describe('main agent default automations (B-924)', () => {
    it('rows match by name, in order; on = exists and active', () => {
        const rows = mainAgentAutomationRows([auto('other', 'active'), auto(MAIN_AGENT_AUTOMATION_NAMES.stuck, 'paused'), auto(MAIN_AGENT_AUTOMATION_NAMES.brief, 'active')]);
        expect(rows.map((r) => [r.kind, r.automation?.name ?? null, r.on])).toEqual([
            ['brief', 'main-agent-brief', true],
            ['stuck', 'main-agent-stuck', false],
            ['wrapup', null, false],
        ]);
    });

    it('switching: off pauses, on resumes, absent creates on the main agent machine, no machine = ask to open it', () => {
        const [brief, stuck, wrapup] = mainAgentAutomationRows([auto(MAIN_AGENT_AUTOMATION_NAMES.brief, 'active', 'a1'), auto(MAIN_AGENT_AUTOMATION_NAMES.stuck, 'paused', 'a2')]);
        const env = { machineId: 'm9', tz: 'Asia/Tokyo' };
        expect(planMainAgentToggle(brief, false, env)).toEqual({ op: 'pause', id: 'a1' });
        expect(planMainAgentToggle(brief, true, env)).toEqual({ op: 'noop' });
        expect(planMainAgentToggle(stuck, true, env)).toEqual({ op: 'resume', id: 'a2' });
        // resuming never needs the machine
        expect(planMainAgentToggle(stuck, true, { machineId: null, tz: 'UTC' })).toEqual({ op: 'resume', id: 'a2' });
        const created = planMainAgentToggle(wrapup, true, env);
        expect(created.op).toBe('create');
        if (created.op !== 'create') return;
        expect(created.body).toMatchObject({
            name: 'main-agent-wrapup', machineId: 'm9', status: 'active',
            trigger: { kind: 'cron', expr: '30 23 * * *', tz: 'Asia/Tokyo' },
            action: { kind: 'send', target: 'main-agent' },
        });
        expect(planMainAgentToggle(wrapup, true, { machineId: null, tz: 'UTC' })).toEqual({ op: 'needMainAgent' });
        expect(planMainAgentToggle(wrapup, false, env)).toEqual({ op: 'noop' });
    });
});

describe('main agent quiet hours (B-924)', () => {
    it('reads the default when absent and keeps every other config field on write', () => {
        expect(readMainAgentQuietHours(null, 'Asia/Tokyo')).toEqual({ enabled: true, start: '00:30', end: '08:30', tz: 'Asia/Tokyo' });
        expect(readMainAgentQuietHours(null)).toEqual({ enabled: true, start: '00:30', end: '08:30', tz: null });
        const prev = { v: 1, skillRoots: ['~/skills'], deniedTools: ['mcp__x__send'], future: { a: 1 }, quietHours: { enabled: true, start: '01:00', end: '07:00', tz: 'UTC' } };
        const next = withQuietHours(prev, { enabled: false, start: '22:00', end: '07:30', tz: 'Asia/Tokyo' }, 42);
        expect(next).toEqual({
            v: 1, skillRoots: ['~/skills'], deniedTools: ['mcp__x__send'], future: { a: 1 },
            quietHours: { enabled: false, start: '22:00', end: '07:30', tz: 'Asia/Tokyo' }, updatedAt: 42,
        });
        expect(prev.quietHours.start).toBe('01:00'); // not mutated
        expect(readMainAgentQuietHours(next, 'UTC')).toEqual({ enabled: false, start: '22:00', end: '07:30', tz: 'Asia/Tokyo' });
        expect(withQuietHours(null, { enabled: true, start: '00:30', end: '08:30', tz: 'UTC' }, 1)).toEqual({ v: 1, quietHours: { enabled: true, start: '00:30', end: '08:30', tz: 'UTC' }, updatedAt: 1 });
    });

    it('HH:MM check', () => {
        expect(isHhmm('00:30')).toBe(true);
        expect(isHhmm('23:59')).toBe(true);
        expect(isHhmm('24:00')).toBe(false);
        expect(isHhmm('7:30')).toBe(false);
        expect(isHhmm('')).toBe(false);
    });
});

describe('B-924 review: time zone shown / editable, restore defaults', () => {
    const auto = (name: string, trigger: any, over: Record<string, unknown> = {}) => ({ id: `id-${name}`, name, description: null, machineId: 'm1', status: 'active', trigger, action: { kind: 'send', target: 'main-agent', prompt: 'p' }, concurrency: 'skip', maxRuntimeMs: 1, nextRunAt: 1, version: 4, lastRunAt: null, lastRunStatus: null, createdAt: 1, updatedAt: 1, ...over }) as any;
    const brief = auto('main-agent-brief', { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' });
    const stuck = auto('main-agent-stuck', { kind: 'interval', everyMs: 3_600_000 });

    it('zone: quiet hours first, else the cron automations, else the browser', () => {
        const rows = mainAgentAutomationRows([brief, stuck]);
        expect(mainAgentZone('Europe/Berlin', rows, 'UTC')).toBe('Europe/Berlin');
        expect(mainAgentZone(null, rows, 'UTC')).toBe('Asia/Tokyo');
        expect(mainAgentZone(null, mainAgentAutomationRows([]), 'UTC')).toBe('UTC');
    });

    it('a zone change moves the cron automations (with their version), not the interval one', () => {
        const rows = mainAgentAutomationRows([brief, stuck]);
        expect(planZoneChange(rows, 'Europe/Berlin')).toEqual([{ id: 'id-main-agent-brief', body: { version: 4, trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin' } } }]);
        expect(planZoneChange(rows, 'Asia/Tokyo')).toEqual([]);
    });

    it('restore creates only the missing ones, switched on, in the shown zone', () => {
        const rows = mainAgentAutomationRows([brief]);
        const plan = planRestoreDefaults(rows, { machineId: 'm1', tz: 'Asia/Tokyo' });
        expect(plan.op).toBe('create');
        const bodies = (plan as { bodies: any[] }).bodies;
        expect(bodies.map(b => [b.name, b.status, b.machineId])).toEqual([['main-agent-stuck', 'active', 'm1'], ['main-agent-wrapup', 'active', 'm1']]);
        expect(bodies[1].trigger).toEqual({ kind: 'cron', expr: '30 23 * * *', tz: 'Asia/Tokyo' });
        expect(planRestoreDefaults(mainAgentAutomationRows([brief, stuck, auto('main-agent-wrapup', { kind: 'cron', expr: '30 23 * * *', tz: 'UTC' })]), { machineId: 'm1', tz: 'UTC' })).toEqual({ op: 'noop' });
        expect(planRestoreDefaults(rows, { machineId: null, tz: 'UTC' })).toEqual({ op: 'needMainAgent' });
    });
});
