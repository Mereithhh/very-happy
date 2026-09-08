import type { TeamAction, TeamState, TeamBot, TeamTask, TeamOperation } from '@slopus/happy-wire';

export type TeamActor = { kind: 'owner' } | { kind: 'agent'; botId: string; generation: number };
export class TeamError extends Error {
    constructor(public code: string, public status = 409) { super(code); }
}
export function requireTeam(condition: unknown, code: string, status = 409): asserts condition {
    if (!condition) throw new TeamError(code, status);
}
export function inTaskTree(state: TeamState, task: TeamTask, ancestorId: string): boolean {
    const seen = new Set<string>();
    let current: TeamTask | undefined = task;
    while (current && !seen.has(current.id)) {
        if (current.id === ancestorId) return true;
        seen.add(current.id);
        current = state.tasks.find(t => t.id === current!.parentTaskId);
    }
    return false;
}
export function actorCanReadTask(state: TeamState, actor: TeamActor, task: TeamTask): boolean {
    if (actor.kind === 'owner') return true;
    if (state.bots.some(b => b.id === actor.botId && b.root)) return true;
    return state.tasks.some(t => (t.assigneeBotId === actor.botId || t.ownerBotId === actor.botId) && inTaskTree(state, task, t.id));
}
export function teamView(state: TeamState, actor: TeamActor): TeamState {
    if (actor.kind === 'owner') return state;
    const tasks = state.tasks.filter(t => actorCanReadTask(state, actor, t));
    const taskIds = new Set(tasks.map(t => t.id));
    const botIds = new Set([actor.botId, ...tasks.flatMap(t => [t.assigneeBotId, t.ownerBotId].filter((x): x is string => !!x))]);
    return { ...state, tasks, bots: state.bots.filter(b => botIds.has(b.id)), messages: state.messages.filter(m => taskIds.has(m.taskId) && (m.recipientBotId === actor.botId || m.senderBotId === actor.botId)), operations: [] };
}
export function reduceTeam(input: TeamState, actor: TeamActor, action: TeamAction, ctx: { now: number; id: () => string }): { team: TeamState; credentialBotId?: string; operationId?: string } {
    requireTeam(input.archivedAt === undefined, 'team_archived');
    const s = structuredClone(input);
    const { now, id } = ctx;
    const currentBot = actor.kind === 'agent' ? s.bots.find(b => b.id === actor.botId) : undefined;
    if (actor.kind === 'agent') requireTeam(currentBot?.generation === actor.generation, 'stale_agent', 403);
    const owner = () => requireTeam(actor.kind === 'owner', 'owner_required', 403);
    const getTask = (taskId: string) => { const t = s.tasks.find(t => t.id === taskId); requireTeam(t && actorCanReadTask(s, actor, t), 'task_not_found', 404); return t; };
    const controls = (t: TeamTask) => requireTeam(actor.kind === 'owner' || t.ownerBotId === actor.botId, 'task_owner_required', 403);
    const msg = (t: TeamTask, recipientBotId: string | null, body: string) => {
        if (!recipientBotId) return;
        requireTeam(s.messages.length < 2000, 'team_message_limit', 429);
        s.messages.push({ id: id(), taskId: t.id, senderBotId: actor.kind === 'agent' ? actor.botId : null, recipientBotId, body, deliveredAt: null, createdAt: now });
    };
    const operation = (t: TeamTask, bot: TeamBot, type: 'spawn' | 'stop', attemptId = t.currentAttemptId) => {
        requireTeam(s.operations.length < 1000, 'team_operation_limit', 429);
        const op: TeamOperation = { id: id(), teamId: s.id, machineId: s.machineId, taskId: t.id, botId: bot.id, attemptId, generation: bot.generation, type, status: 'pending', claimId: null, claimedAt: null, error: null, sessionId: bot.sessionId, directory: bot.directory, assistant: bot.assistant, prompt: type === 'spawn' ? `Task ${t.id}\n${t.goal}\nAcceptance:\n${t.acceptance.join('\n')}` : '', createdAt: now };
        s.operations.push(op);
        return op;
    };
    const cleanup = (t: TeamTask) => {
        const bot = s.bots.find(b => b.id === t.assigneeBotId)!;
        const spawn = s.operations.find(o => o.type === 'spawn' && o.attemptId === t.currentAttemptId);
        if (spawn?.status === 'pending') { spawn.status = 'failed'; spawn.error = 'task_closed_before_spawn'; }
        const otherWork = s.tasks.some(other => other.id !== t.id && other.assigneeBotId === bot.id && !['done', 'cancelled'].includes(other.status));
        if (bot.managed && !otherWork && (bot.sessionId || spawn?.status === 'claimed' || spawn?.status === 'unknown')) {
            t.cleanup = 'pending';
            if (bot.sessionId) operation(t, bot, 'stop');
        }
    };
    let credentialBotId: string | undefined;
    let operationId: string | undefined;
    switch (action.type) {
        case 'archive': {
            owner();
            requireTeam(!s.tasks.some(t => !['done', 'cancelled'].includes(t.status)), 'team_has_active_tasks');
            requireTeam(!s.operations.some(o => ['pending', 'claimed', 'unknown'].includes(o.status) || (o.status === 'failed' && o.error !== 'task_closed_before_spawn')), 'team_has_unresolved_operations');
            requireTeam(!s.tasks.some(t => ['pending', 'failed'].includes(t.cleanup)), 'team_cleanup_unfinished');
            s.archivedAt = now;
            break;
        }
        case 'join': {
            owner();
            if (action.botId) requireTeam(!s.bots.some(b => b.sessionId === action.sessionId && b.id !== action.botId), 'session_already_bound');
            let bot = action.botId ? s.bots.find(b => b.id === action.botId) : s.bots.find(b => b.sessionId === action.sessionId);
            if (action.botId) requireTeam(bot, 'bot_not_found', 404);
            if (bot && bot.sessionId === action.sessionId) { bot.name = action.name; credentialBotId = bot.id; break; }
            if (bot) {
                bot.generation++; bot.sessionId = action.sessionId; bot.name = action.name;
                for (const task of s.tasks.filter(t => t.assigneeBotId === bot!.id && !['done', 'cancelled'].includes(t.status))) {
                    task.attempts.find(a => a.id === task.currentAttemptId)!.status = 'superseded';
                    task.currentAttemptId = id(); task.status = 'running';
                    task.attempts.push({ id: task.currentAttemptId, botId: bot.id, generation: bot.generation, goalVersion: task.goalVersion, status: 'running', result: null });
                }
            } else {
                requireTeam(s.bots.length < 32, 'team_bot_limit', 429);
                bot = { id: id(), name: action.name, sessionId: action.sessionId, generation: 1, root: true, managed: false, assistant: 'claude', directory: null };
                s.bots.push(bot);
            }
            credentialBotId = bot.id;
            break;
        }
        case 'delegate': {
            requireTeam(s.tasks.length < 200, 'team_task_limit', 429);
            const parent = action.parentTaskId ? getTask(action.parentTaskId) : undefined;
            if (actor.kind === 'agent') requireTeam(parent ? parent.assigneeBotId === actor.botId : currentBot?.root, 'delegation_denied', 403);
            if (parent) requireTeam(!['done', 'cancelled', 'submitted'].includes(parent.status), 'parent_not_running');
            if (parent) {
                let depth = 1; let p: TeamTask | undefined = parent;
                while (p?.parentTaskId) { depth++; p = s.tasks.find(t => t.id === p!.parentTaskId); }
                requireTeam(depth < 8, 'team_depth_limit', 429);
            }
            let bot = action.assigneeBotId ? s.bots.find(b => b.id === action.assigneeBotId) : undefined;
            if (action.assigneeBotId) requireTeam(bot, 'bot_not_found', 404);
            if (bot && actor.kind === 'agent') requireTeam(currentBot?.root || bot.id === actor.botId || s.tasks.some(t => actorCanReadTask(s, actor, t) && t.assigneeBotId === bot!.id), 'bot_outside_scope', 403);
            if (!bot) {
                requireTeam(s.bots.length < 32, 'team_bot_limit', 429);
                bot = { id: id(), name: action.botName ?? 'Worker', sessionId: null, generation: 1, root: false, managed: true, assistant: action.assistant ?? 'claude', directory: action.directory ?? null };
                s.bots.push(bot);
            }
            requireTeam(bot.sessionId || bot.managed, 'bot_not_bound');
            requireTeam(!s.operations.some(o => o.botId === bot!.id && o.type === 'stop' && o.status !== 'completed'), 'bot_cleanup_pending');
            requireTeam(!s.tasks.some(t => t.assigneeBotId === bot!.id && !['done', 'cancelled'].includes(t.status)), 'bot_busy');
            if (action.assigneeBotId && !bot.sessionId) bot.generation++;
            const attemptId = id();
            const t: TeamTask = { id: id(), parentTaskId: parent?.id ?? null, goal: action.goal, acceptance: action.acceptance, goalVersion: 1, ownerBotId: actor.kind === 'agent' ? actor.botId : null, assigneeBotId: bot.id, status: bot.sessionId ? 'running' : 'queued', attempts: [{ id: attemptId, botId: bot.id, generation: bot.generation, goalVersion: 1, status: bot.sessionId ? 'running' : 'pending', result: null }], currentAttemptId: attemptId, cleanup: 'none' };
            s.tasks.push(t);
            if (bot.sessionId) msg(t, bot.id, `New task ${t.id}: ${t.goal}\nAcceptance:\n${t.acceptance.join('\n')}`);
            else operation(t, bot, 'spawn');
            break;
        }
        case 'message': {
            const t = getTask(action.taskId);
            const recipient = action.recipientBotId ?? t.assigneeBotId;
            requireTeam(recipient === t.assigneeBotId || recipient === t.ownerBotId, 'recipient_outside_task', 403);
            msg(t, recipient, action.body); break;
        }
        case 'submit': {
            const t = getTask(action.taskId);
            requireTeam(actor.kind === 'owner' || actor.botId === t.assigneeBotId, 'assignee_required', 403);
            requireTeam(t.currentAttemptId === action.attemptId && t.goalVersion === action.goalVersion, 'stale_attempt');
            requireTeam(t.status === 'running', 'task_not_running');
            requireTeam(!s.tasks.some(child => child.parentTaskId === t.id && !['done', 'cancelled'].includes(child.status)), 'children_unfinished');
            const attempt = t.attempts.find(a => a.id === t.currentAttemptId)!;
            requireTeam(actor.kind === 'owner' || attempt.generation === actor.generation, 'stale_attempt');
            t.status = 'submitted'; attempt.status = 'submitted'; attempt.result = action.result;
            msg(t, t.ownerBotId, `Task ${t.id} submitted:\n${action.result}`); break;
        }
        case 'accept': {
            const t = getTask(action.taskId); controls(t); requireTeam(t.currentAttemptId === action.attemptId && t.goalVersion === action.goalVersion, 'stale_attempt'); requireTeam(t.status === 'submitted', 'task_not_submitted');
            t.status = 'done'; t.attempts.find(a => a.id === t.currentAttemptId)!.status = 'accepted'; cleanup(t); break;
        }
        case 'return': {
            const t = getTask(action.taskId); controls(t); requireTeam(t.currentAttemptId === action.attemptId && t.goalVersion === action.goalVersion, 'stale_attempt'); requireTeam(t.status === 'submitted', 'task_not_submitted');
            t.attempts.find(a => a.id === t.currentAttemptId)!.status = 'superseded';
            const bot = s.bots.find(b => b.id === t.assigneeBotId)!;
            t.currentAttemptId = id(); t.status = 'running';
            t.attempts.push({ id: t.currentAttemptId, botId: bot.id, generation: bot.generation, goalVersion: t.goalVersion, status: 'running', result: null });
            msg(t, t.assigneeBotId, `Revision requested (attempt ${t.currentAttemptId}): ${action.reason}`); break;
        }
        case 'cancel': {
            const t = getTask(action.taskId); controls(t); requireTeam(t.currentAttemptId === action.attemptId && t.goalVersion === action.goalVersion, 'stale_attempt'); requireTeam(!['done', 'cancelled'].includes(t.status), 'task_already_closed');
            const descendants = s.tasks.filter(child => inTaskTree(s, child, t.id) && !['done', 'cancelled'].includes(child.status));
            for (const child of descendants) { child.status = 'cancelled'; child.attempts.find(a => a.id === child.currentAttemptId)!.status = 'cancelled'; }
            for (const child of descendants) { msg(child, child.assigneeBotId, `Cancelled: ${action.reason}`); cleanup(child); }
            break;
        }
        case 'handoff': {
            const t = getTask(action.taskId); controls(t); requireTeam(t.currentAttemptId === action.attemptId && t.goalVersion === action.goalVersion, 'stale_attempt'); requireTeam(!['done', 'cancelled'].includes(t.status), 'task_already_closed');
            requireTeam(!s.tasks.some(child => child.parentTaskId === t.id && !['done', 'cancelled'].includes(child.status)), 'children_unfinished');
            const bot = s.bots.find(b => b.id === action.assigneeBotId); requireTeam(bot, 'bot_not_found', 404);
            requireTeam(bot.id !== t.assigneeBotId, 'same_assignee');
            requireTeam(!s.operations.some(o => o.botId === bot.id && o.type === 'stop' && o.status !== 'completed'), 'bot_cleanup_pending');
            requireTeam(!s.tasks.some(other => other.assigneeBotId === bot.id && !['done', 'cancelled'].includes(other.status)), 'bot_busy');
            if (actor.kind === 'agent') requireTeam(currentBot?.root || s.tasks.some(other => actorCanReadTask(s, actor, other) && other.assigneeBotId === bot.id), 'bot_outside_scope', 403);
            cleanup(t); t.attempts.find(a => a.id === t.currentAttemptId)!.status = 'superseded';
            if (!bot.sessionId) bot.generation++;
            t.assigneeBotId = bot.id; t.currentAttemptId = id(); t.cleanup = 'none';
            t.attempts.push({ id: t.currentAttemptId, botId: bot.id, generation: bot.generation, goalVersion: t.goalVersion, status: bot.sessionId ? 'running' : 'pending', result: null });
            t.status = bot.sessionId ? 'running' : 'queued';
            if (bot.sessionId) msg(t, bot.id, `Task handed off: ${t.goal}`); else operation(t, bot, 'spawn');
            break;
        }
        case 'claim-operation': {
            owner(); requireTeam(action.machineId === s.machineId, 'machine_mismatch', 403);
            const op = s.operations.find(o => o.id === action.operationId); requireTeam(op, 'operation_not_found', 404);
            requireTeam(op.status === 'pending', 'operation_not_pending');
            op.status = 'claimed'; op.claimId = id(); op.claimedAt = now; operationId = op.id;
            if (op.type === 'spawn') credentialBotId = op.botId;
            break;
        }
        case 'complete-operation':
        case 'fail-operation': {
            owner(); requireTeam(action.machineId === s.machineId, 'machine_mismatch', 403);
            const op = s.operations.find(o => o.id === action.operationId); requireTeam(op, 'operation_not_found', 404);
            requireTeam(op.claimId === action.claimId && ['claimed', 'unknown', 'failed'].includes(op.status), 'stale_claim');
            const bot = s.bots.find(b => b.id === op.botId)!;
            const t = s.tasks.find(t => t.id === op.taskId)!;
            if (action.type === 'fail-operation') {
                op.status = action.unknown ? 'unknown' : 'failed'; op.error = action.error;
                if (op.type === 'stop') t.cleanup = 'failed';
            } else {
                if (op.type === 'spawn') {
                    requireTeam(action.sessionId, 'session_required', 400);
                    requireTeam(bot.generation === op.generation, 'stale_generation');
                    requireTeam(!s.bots.some(other => other.id !== bot.id && other.sessionId === action.sessionId), 'session_already_bound');
                    requireTeam(!bot.sessionId || bot.sessionId === action.sessionId, 'bot_already_bound');
                    bot.sessionId = action.sessionId; op.sessionId = action.sessionId;
                    if (t.currentAttemptId === op.attemptId && t.status === 'queued') { t.status = 'running'; t.attempts.find(a => a.id === op.attemptId)!.status = 'running'; }
                    else operation(t, bot, 'stop', op.attemptId);
                } else {
                    if (t.currentAttemptId === op.attemptId) t.cleanup = 'done';
                    if (bot.generation === op.generation && bot.sessionId === op.sessionId) bot.sessionId = null;
                }
                op.status = 'completed';
            }
            operationId = op.id; break;
        }
        case 'session-event': {
            owner();
            const bot = s.bots.find(b => b.sessionId === action.sessionId);
            requireTeam(bot, 'session_not_bound', 404);
            bot.lastEvent = action.event; bot.lastEventAt = now;
            for (const task of s.tasks.filter(t => t.assigneeBotId === bot.id && !['done', 'cancelled'].includes(t.status))) {
                const before = s.messages.length;
                msg(task, task.ownerBotId, `Agent ${bot.name}: ${action.event}. Task ${task.id} still requires explicit submission and acceptance.`);
                if (s.messages.length > before) s.messages[s.messages.length - 1].source = 'system';
            }
            break;
        }
        case 'message-delivered': {
            const m = s.messages.find(m => m.id === action.messageId); requireTeam(m, 'message_not_found', 404);
            requireTeam(actor.kind === 'owner' || m.recipientBotId === actor.botId, 'recipient_required', 403);
            m.deliveredAt ??= now; break;
        }
    }
    s.version++;
    requireTeam(JSON.stringify(s).length <= 2_000_000, 'team_size_limit', 429);
    return { team: s, credentialBotId, operationId };
}
