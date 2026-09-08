import type { TeamAction, TeamSchedule, TeamState } from '@slopus/happy-wire';
import type { TeamActor } from './reducer';
import { requireTeam } from './errors';

type ScheduleAction = Extract<TeamAction, { type: 'schedule-create' | 'schedule-pause' | 'schedule-resume' | 'schedule-cancel' }>;
const terminalMessage = (m: TeamState['messages'][number]) => !!m.scheduleId && (m.deliveredAt !== null || m.cancelledAt !== undefined);
export function pruneScheduleMessages(team: TeamState, justFinishedId?: string): void {
    const finished = team.messages.filter(terminalMessage).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    // The just-acknowledged/cancelled row was pending in the database snapshot.
    // Keep it in this transaction; only rows already terminal may be deleted.
    const keepCurrent = finished.some(m => m.id === justFinishedId);
    const retained = new Set(finished.filter(m => m.id !== justFinishedId).slice(0, keepCurrent ? 63 : 64).map(m => m.id));
    if (justFinishedId && keepCurrent) retained.add(justFinishedId);
    const expired = new Set(finished.filter(m => !retained.has(m.id)).map(m => m.id));
    team.messages = team.messages.filter(m => !expired.has(m.id));
}
export function pruneScheduleRecords(team: TeamState): void {
    const schedules = team.schedules ?? [];
    const terminal = schedules.filter(s => ['cancelled', 'completed'].includes(s.status)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) || b.id.localeCompare(a.id));
    const removed = new Set(terminal.slice(64).map(s => s.id));
    team.schedules = schedules.filter(s => !removed.has(s.id));
}
export function applyScheduleAction(team: TeamState, actor: TeamActor, action: ScheduleAction, now: number, id: () => string): string {
    const schedules = team.schedules ??= [];
    const allowed = (botId: string) => requireTeam(actor.kind === 'owner' || (actor.botId === botId && team.bots.some(b => b.id === actor.botId && b.root)), 'schedule_owner_required', 403);
    if (action.type === 'schedule-create') {
        allowed(action.botId);
        requireTeam(team.bots.some(b => b.id === action.botId), 'bot_not_found', 404);
        requireTeam(schedules.filter(s => ['active', 'paused'].includes(s.status)).length < 64, 'team_schedule_limit', 429);
        const schedule: TeamSchedule = { id: id(), name: action.name, botId: action.botId, machineId: team.machineId, body: action.body, status: 'active', version: 1, nextRunAt: action.runAt, ...(action.intervalMs ? { intervalMs: action.intervalMs } : {}), fireCount: 0, createdAt: now };
        schedules.push(schedule);
        pruneScheduleRecords(team);
        return schedule.id;
    }
    const schedule = schedules.find(s => s.id === action.scheduleId);
    requireTeam(schedule, 'schedule_not_found', 404);
    allowed(schedule.botId);
    requireTeam(schedule.version === action.version, 'stale_schedule');
    requireTeam(!['cancelled', 'completed'].includes(schedule.status), 'schedule_closed');
    const pendingMessageId = schedule.pendingMessageId;
    if (action.type === 'schedule-resume') {
        requireTeam(schedule.status === 'paused', 'schedule_not_paused');
        schedule.status = 'active';
        schedule.nextRunAt = schedule.intervalMs ? now + schedule.intervalMs : Math.max(now, schedule.nextRunAt ?? now);
    } else {
        if (action.type === 'schedule-pause') requireTeam(schedule.status === 'active', 'schedule_not_active');
        schedule.status = action.type === 'schedule-pause' ? 'paused' : 'cancelled';
        if (schedule.pendingMessageId) {
            const message = team.messages.find(m => m.id === schedule.pendingMessageId && m.scheduleId === schedule.id);
            if (message && message.deliveredAt === null) message.cancelledAt = now;
            delete schedule.pendingMessageId;
        }
        if (action.type === 'schedule-cancel') { schedule.nextRunAt = null; schedule.finishedAt = now; }
    }
    schedule.version++;
    pruneScheduleMessages(team, pendingMessageId);
    pruneScheduleRecords(team);
    return schedule.id;
}
/** Pure due calculation; persistence atomically commits this state and its messages. */
export function advanceSchedules(input: TeamState, now: number): { team: TeamState; fired: number } {
    const team = structuredClone(input);
    let fired = 0;
    if (team.archivedAt !== undefined) return { team, fired };
    for (const schedule of team.schedules ?? []) {
        if (schedule.status !== 'active' || schedule.nextRunAt === null || schedule.nextRunAt > now || schedule.pendingMessageId) continue;
        requireTeam(schedule.machineId === team.machineId && team.bots.some(b => b.id === schedule.botId), 'schedule_binding_invalid');
        pruneScheduleMessages(team);
        requireTeam(team.messages.length < 2000, 'team_message_limit', 429);
        const messageId = `${schedule.id}-${schedule.fireCount + 1}`;
        requireTeam(!team.messages.some(m => m.id === messageId), 'schedule_occurrence_conflict');
        team.messages.push({ id: messageId, taskId: null, scheduleId: schedule.id, senderBotId: null, source: 'system', recipientBotId: schedule.botId, body: schedule.body, deliveredAt: null, createdAt: now });
        schedule.pendingMessageId = messageId;
        schedule.lastFiredAt = now;
        schedule.fireCount++;
        schedule.version++;
        schedule.nextRunAt = schedule.intervalMs ? schedule.nextRunAt + (Math.floor((now - schedule.nextRunAt) / schedule.intervalMs) + 1) * schedule.intervalMs : null;
        fired++;
    }
    if (fired) team.version++;
    requireTeam(JSON.stringify(team).length <= 2_000_000, 'team_size_limit', 429);
    return { team, fired };
}
export function acknowledgeScheduleMessage(team: TeamState, messageId: string, now: number): void {
    const schedule = team.schedules?.find(s => s.pendingMessageId === messageId);
    if (!schedule) return;
    delete schedule.pendingMessageId;
    if (!schedule.intervalMs) { schedule.status = 'completed'; schedule.finishedAt = now; }
    schedule.version++;
    pruneScheduleMessages(team, messageId);
    pruneScheduleRecords(team);
}
