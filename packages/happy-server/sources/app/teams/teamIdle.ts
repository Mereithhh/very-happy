import type { TeamBot, TeamIdleMember, TeamState } from '@slopus/happy-wire';

/**
 * B-769: a member's turn-end `idle` no longer wakes its task owner. It is folded
 * into the owner's next team message (digest) and shown by team_inspect
 * (`idleMembers`); only an idle stretch this long, with the task still not
 * submitted, wakes the owner on its own (once per stretch).
 */
export const TEAM_IDLE_ESCALATE_MS = 30 * 60 * 1000;

/** Start of `bot`'s current idle stretch, or null. The server sees no turn-start
 *  event, so a team message delivered to the bot or sent by it after its last
 *  idle proves it was working again. B-769b: the stretch starts no earlier than the
 *  bot's newest work (`workAssignedAt`) — the incident: a member idle 220 min after
 *  its previous task got a new one and its owner was told「idle for 220 min」3 s
 *  later, before the launch / task message reached it. An unbound bot (its session
 *  stopped, a launch pending) has no current idle at all. */
export function idleSince(team: Pick<TeamState, 'messages'>, bot: TeamBot): number | null {
    if (!bot.sessionId || bot.lastEvent !== 'idle' || bot.lastEventAt === undefined) return null;
    const at = Math.max(bot.lastEventAt, bot.workAssignedAt ?? -Infinity);
    const woke = team.messages.some(m => (m.recipientBotId === bot.id && m.deliveredAt !== null && m.deliveredAt > at) || (m.senderBotId === bot.id && m.createdAt > at));
    return woke ? null : at;
}

/** Idle members whose queued/running (not yet submitted) tasks `ownerBotId` owns.
 *  B-769b: only a turn end on the current work counts — a bot given new work since
 *  its idle has not finished a turn on it yet (the digest is not an escalation). */
export function idleMembersFor(team: Pick<TeamState, 'bots' | 'tasks' | 'messages'>, ownerBotId: string): TeamIdleMember[] {
    const members: TeamIdleMember[] = [];
    for (const bot of team.bots) {
        if (bot.id === ownerBotId) continue;
        const since = idleSince(team, bot);
        if (since === null || since !== bot.lastEventAt) continue;
        const taskIds = team.tasks.filter(t => t.assigneeBotId === bot.id && t.ownerBotId === ownerBotId && ['queued', 'running'].includes(t.status)).map(t => t.id);
        if (taskIds.length) members.push({ botId: bot.id, name: bot.name, since, taskIds });
    }
    return members;
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The digest appended to the next message `recipientBotId` receives: idle
 *  stretches that began after its previous team message (so each is told once). */
export function idleDigest(team: Pick<TeamState, 'bots' | 'tasks' | 'messages'>, recipientBotId: string, now: number, excludeBotIds: readonly string[] = []): string {
    const previous = Math.max(-Infinity, ...team.messages.filter(m => m.recipientBotId === recipientBotId).map(m => m.createdAt));
    const fresh = idleMembersFor(team, recipientBotId).filter(m => m.since > previous && !excludeBotIds.includes(m.botId));
    if (!fresh.length) return '';
    return `\n\nMeanwhile idle (no action needed; see team_inspect idleMembers): ${fresh.map(m => `${m.name} (${minutes(now - m.since)} min; task ${m.taskIds.join(', ')} not yet submitted)`).join('; ')}.`;
}

/** Pure: wake owners of members idle ≥ TEAM_IDLE_ESCALATE_MS without submitting.
 *  Never throws: it runs inside the schedule tick, which must keep advancing schedules. */
export function escalateIdleMembers(input: TeamState, now: number, id: () => string): { team: TeamState; fired: number } {
    const team = structuredClone(input);
    let fired = 0;
    if (team.archivedAt !== undefined) return { team, fired };
    for (const bot of team.bots) {
        const since = idleSince(team, bot);
        if (since === null || now - since < TEAM_IDLE_ESCALATE_MS || bot.idleEscalatedAt === since) continue;
        const tasks = team.tasks.filter(t => t.assigneeBotId === bot.id && t.ownerBotId && ['queued', 'running'].includes(t.status));
        if (!tasks.length) continue;
        if (team.messages.length + tasks.length > 2000) break;
        for (const task of tasks) {
            const body = `Agent ${bot.name}: idle for ${minutes(now - since)} min. Task ${task.id} is still not submitted and requires explicit submission and acceptance.` + idleDigest(team, task.ownerBotId!, now, [bot.id]);
            team.messages.push({ id: id(), taskId: task.id, senderBotId: null, source: 'system', recipientBotId: task.ownerBotId!, body, deliveredAt: null, createdAt: now });
            fired++;
        }
        bot.idleEscalatedAt = since;
    }
    if (!fired || JSON.stringify(team).length > 2_000_000) return { team: input, fired: 0 };
    team.version++;
    return { team, fired };
}
