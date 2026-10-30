import { describe, expect, it, vi } from 'vitest';
import { finalizeRemotePrompt } from './finalizeRemotePrompt';
import { parseSpecialCommand } from '@/parsers/specialCommands';

function deps() {
    const board = { onTurnStart: vi.fn(), decorate: vi.fn(async (p: string) => `[board]\n${p}`) };
    const project = { decorate: vi.fn(async (p: string) => `[project]\n${p}`) };
    return { board, project, sourceIds: ['l1'] };
}

describe('finalizeRemotePrompt', () => {
    it('decorates an ordinary prompt with the board, then the project prefix', async () => {
        const d = deps();
        expect(await finalizeRemotePrompt('hello', d)).toBe('[project]\n[board]\nhello');
        expect(d.board.onTurnStart).toHaveBeenCalledWith(['l1']);
    });

    it.each(['/compact', '/compact keep the plan', '/clear'])('sends %j verbatim so Claude Code still runs it (Owner 10-30)', async (command) => {
        const d = deps();
        const out = await finalizeRemotePrompt(command, d);
        expect(out).toBe(command);
        // claudeRemote recognises the command on the finalized string.
        expect(parseSpecialCommand(out).type).not.toBeNull();
        expect(d.board.onTurnStart).not.toHaveBeenCalled();
        expect(d.board.decorate).not.toHaveBeenCalled();
        expect(d.project.decorate).not.toHaveBeenCalled();
    });

    it('works without a lead board', async () => {
        const d = deps();
        expect(await finalizeRemotePrompt('hi', { project: d.project })).toBe('[project]\nhi');
        expect(await finalizeRemotePrompt('/compact', { project: d.project })).toBe('/compact');
    });
});
