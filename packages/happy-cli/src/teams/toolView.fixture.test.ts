import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { teamActionReceipt, teamTaskToolView, teamToolView } from './toolView';

/**
 * B-881: the lead's real team (68 tasks / 145 messages, 589,754 characters raw) with every text
 * replaced by `§<length>` and every id by a synthetic one. Each placeholder expands to a unique
 * text of the original length (CJK, so one character each like the original), so sizes stay real
 * and a leaked goal or body is detectable.
 */
function leadTeam(): TeamState {
    let seed = 0;
    const filler = '占位文本 placeholder ';
    const expand = (value: unknown): unknown => {
        if (typeof value === 'string' && /^§\d+$/.test(value)) {
            const length = Number(value.slice(1));
            const text = `<${++seed}>${filler.repeat(Math.ceil(length / filler.length) + 1)}`;
            return text.slice(0, length);
        }
        if (Array.isArray(value)) return value.map(expand);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
        return value;
    };
    return expand(JSON.parse(readFileSync(new URL('./__fixtures__/b881-lead-team.json', import.meta.url), 'utf8'))) as TeamState;
}
const size = (value: unknown) => JSON.stringify(value).length;
const lead = (team: TeamState) => team.bots.find(b => b.root)!.id;

describe('B-881 team_* answers on the lead\'s 68-task / 145-message team', () => {
    it('the fixture is the incident\'s size', () => {
        const team = leadTeam();
        expect(team.tasks).toHaveLength(68);
        expect(team.messages).toHaveLength(145);
        expect(size(team)).toBeGreaterThan(550_000);
    });
    it('team_inspect\'s default view stays under 20,000 characters', () => {
        const team = leadTeam();
        const view = teamToolView(team, { botId: lead(team) }) as any;
        expect(size(view)).toBeLessThanOrEqual(20_000);
        expect(view.operations).toBeUndefined();
        expect(view.messages.length).toBeGreaterThan(0);
        expect(view.messages.length).toBeLessThanOrEqual(20 + team.messages.filter(m => m.deliveredAt === null && m.recipientBotId === lead(team)).length);
        expect(view.tasks.map((t: any) => t.id)).toEqual(team.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').map(t => t.id));
    });
    it('a write answers with a receipt: no messages, operations or other tasks\' goals', () => {
        const team = leadTeam();
        const acted = team.tasks.find(t => t.status === 'running')!;
        const receipt = teamActionReceipt({ team, operation: team.operations.find(o => o.taskId === acted.id) }, acted.id) as any;
        const text = JSON.stringify(receipt);
        expect(receipt).toMatchObject({ ok: true, taskId: acted.id, task: { id: acted.id, status: 'running', currentAttemptId: acted.currentAttemptId, goalVersion: acted.goalVersion, assigneeBotId: acted.assigneeBotId }, team: { version: team.version } });
        expect(receipt.messages).toBeUndefined();
        expect(receipt.operations).toBeUndefined();
        expect(receipt.team.tasks).toBeUndefined();
        expect(receipt.operation.prompt).toBeUndefined();
        expect(receipt.task.goal.length).toBeLessThanOrEqual(201);
        for (const task of team.tasks) {
            if (task.id !== acted.id) expect(text).not.toContain(task.goal.slice(0, 40));
        }
        for (const message of team.messages) expect(text).not.toContain(message.body.slice(0, 40));
        expect(size(receipt)).toBeLessThan(3_000);
    });
    it('team_inspect with taskId returns that task in full', () => {
        const team = leadTeam();
        const task = [...team.tasks].sort((a, b) => b.goal.length - a.goal.length)[0];
        const detail = teamTaskToolView(team, task.id) as any;
        expect(detail.task).toEqual(task);
        expect(detail.task.goal).toBe(task.goal);
        expect(detail.task.acceptance).toEqual(task.acceptance);
        expect(detail.messages).toEqual(team.messages.filter(m => m.taskId === task.id));
    });
});
