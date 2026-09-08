import { describe, it, expect } from 'vitest';
import type { TeamAction, TeamState } from '@slopus/happy-wire';
import { reduceTeam, teamView, type TeamActor } from './reducer';
import { advanceSchedules, pruneScheduleMessages } from './schedules';
const owner: TeamActor = { kind: 'owner' };
function fixture() {
    let next = 0;
    let team: TeamState = { id: 'team', name: 'Team', machineId: 'machine', version: 0, bots: [{ id: 'bot', name: 'Root', root: true, managed: false, generation: 1, sessionId: 'session', assistant: 'claude', directory: null }], tasks: [], messages: [], operations: [], createdAt: 0 };
    return {
        get team() { return team; },
        act(action: TeamAction, actor = owner, now = 1000) { const result = reduceTeam(team, actor, action, { now, id: () => `id-${++next}` }); team = result.team; return result; },
        fire(now: number) { const result = advanceSchedules(team, now); team = result.team; return result.fired; },
        ack() { const message = team.messages.find(m => m.id === team.schedules![0].pendingMessageId)!; this.act({ type: 'message-delivered', messageId: message.id, recipientBotId: 'bot', generation: 1, sessionId: 'session' }); },
    };
}
describe('persistent schedule semantics', () => {
    it('fires one time and completes only after a fenced delivery ACK', () => {
        const f = fixture(); f.act({ type: 'schedule-create', name: 'Once', botId: 'bot', body: 'Inspect', runAt: 2000 });
        expect(f.fire(1999)).toBe(0); expect(f.fire(2000)).toBe(1); expect(f.fire(9000)).toBe(0);
        expect(f.team.schedules![0].status).toBe('active'); expect(f.team.messages[0].taskId).toBeNull();
        f.ack(); expect(f.team.schedules![0].status).toBe('completed'); expect(f.fire(10000)).toBe(0);
    });
    it('coalesces missed intervals and holds at most one pending message while offline', () => {
        const f = fixture(); f.team.bots[0].sessionId = null;
        f.act({ type: 'schedule-create', name: 'Periodic', botId: 'bot', body: 'Inspect', runAt: 1000, intervalMs: 60000 });
        expect(f.fire(181000)).toBe(1); expect(f.team.schedules![0].nextRunAt).toBe(241000);
        expect(f.fire(1000000)).toBe(0); expect(f.team.messages).toHaveLength(1);
        f.team.bots[0].sessionId = 'session'; f.ack();
        expect(f.fire(1000000)).toBe(1); expect(f.team.schedules![0].nextRunAt).toBeGreaterThan(1000000);
    });
    it('pauses pending delivery, rejects stale controls, and resumes from a new interval', () => {
        const f = fixture(); f.act({ type: 'schedule-create', name: 'Periodic', botId: 'bot', body: 'Inspect', runAt: 1000, intervalMs: 60000 }); f.fire(1000);
        const schedule = f.team.schedules![0];
        f.act({ type: 'schedule-pause', scheduleId: schedule.id, version: schedule.version }, owner, 2000);
        expect(f.team.messages[0].cancelledAt).toBe(2000); expect(f.fire(1000000)).toBe(0);
        expect(() => f.act({ type: 'schedule-resume', scheduleId: schedule.id, version: schedule.version })).toThrow('stale_schedule');
        f.act({ type: 'schedule-resume', scheduleId: schedule.id, version: f.team.schedules![0].version }, owner, 3000);
        expect(f.team.schedules![0].nextRunAt).toBe(63000); expect(f.fire(62999)).toBe(0); expect(f.fire(63000)).toBe(1);
    });
    it('cancel prevents future ticks and rejects a late delivery ACK', () => {
        const f = fixture(); f.act({ type: 'schedule-create', name: 'Once', botId: 'bot', body: 'Inspect', runAt: 1000 }); f.fire(1000);
        const message = f.team.messages[0]; const schedule = f.team.schedules![0];
        f.act({ type: 'schedule-cancel', scheduleId: schedule.id, version: schedule.version });
        expect(f.fire(100000)).toBe(0);
        expect(() => f.act({ type: 'message-delivered', messageId: message.id, recipientBotId: 'bot', generation: 1, sessionId: 'session' })).toThrow('message_cancelled');
        f.act({ type: 'archive' }); expect(f.team.archivedAt).toBe(1000);
    });
    it('grants only a root managing its own Bot and filters private schedule bodies', () => {
        const f = fixture(); f.team.bots.push({ ...f.team.bots[0], id: 'worker', root: false });
        const root: TeamActor = { kind: 'agent', botId: 'bot', generation: 1 };
        f.act({ type: 'schedule-create', name: 'Private', botId: 'bot', body: 'Private instructions', runAt: 1000 }, root); f.fire(1000);
        expect(() => f.act({ type: 'schedule-create', name: 'No', botId: 'worker', body: 'x', runAt: 1000 }, root)).toThrow('schedule_owner_required');
        const worker: TeamActor = { kind: 'agent', botId: 'worker', generation: 1 };
        expect(() => f.act({ type: 'schedule-create', name: 'No', botId: 'worker', body: 'x', runAt: 1000 }, worker)).toThrow('schedule_owner_required');
        expect(teamView(f.team, worker).schedules).toHaveLength(0); expect(teamView(f.team, worker).messages).toHaveLength(0);
    });
    it('prunes only terminal schedule messages and preserves ordinary and pending messages', () => {
        const f = fixture();
        for (let i = 0; i < 70; i++) f.team.messages.push({ id: `s-${i}`, taskId: null, scheduleId: 's', senderBotId: null, recipientBotId: 'bot', body: 'x', deliveredAt: i, createdAt: i });
        f.team.messages.push({ id: 'normal', taskId: 'task', senderBotId: null, recipientBotId: 'bot', body: 'keep', deliveredAt: 1, createdAt: 0 });
        f.team.messages.push({ id: 'pending', taskId: null, scheduleId: 's', senderBotId: null, recipientBotId: 'bot', body: 'keep', deliveredAt: null, createdAt: 0 });
        pruneScheduleMessages(f.team);
        expect(f.team.messages).toHaveLength(66); expect(f.team.messages.some(m => m.id === 'normal')).toBe(true); expect(f.team.messages.some(m => m.id === 'pending')).toBe(true);
    });
    it('requires schedules to be stopped before Team archival', () => {
        const f = fixture(); f.act({ type: 'schedule-create', name: 'Once', botId: 'bot', body: 'Inspect', runAt: 1000 });
        expect(() => f.act({ type: 'archive' })).toThrow('team_has_active_schedules');
    });
    it('releases active quota on cancellation while bounding terminal schedule records', () => {
        const f = fixture();
        for (let i = 0; i < 64; i++) f.act({ type: 'schedule-create', name: `Active ${i}`, botId: 'bot', body: 'Inspect', runAt: 1000 });
        expect(() => f.act({ type: 'schedule-create', name: 'Over quota', botId: 'bot', body: 'Inspect', runAt: 1000 })).toThrow('team_schedule_limit');
        for (let i = 0; i < 100; i++) {
            const first = f.team.schedules!.find(s => s.status === 'active')!;
            f.act({ type: 'schedule-cancel', scheduleId: first.id, version: first.version }, owner, 2000 + i);
            f.act({ type: 'schedule-create', name: `Replacement ${i}`, botId: 'bot', body: 'Inspect', runAt: 1000 });
        }
        expect(f.team.schedules).toHaveLength(128);
        expect(f.team.schedules!.filter(s => s.status === 'active')).toHaveLength(64);
    });

});
