import { parseSpecialCommand } from '@/parsers/specialCommands';

type PromptDecorator = { decorate: (prompt: string) => Promise<string> };

/**
 * The exact string a web prompt reaches the Claude SDK as (B-645 / B-766):
 * a lead's open briefing-board items, then the project prefix / digest.
 *
 * `/compact` and `/clear` go verbatim. Claude Code runs a slash command only
 * when the prompt starts with it, and claudeRemote recognises them the same
 * way — a project prefix in front turned `/compact` into a chat message the
 * model answered with "I can't run that" (Owner, 10-30). The command also does
 * not use up the one-time project prefix or start a board turn: the next real
 * prompt still carries them.
 */
export async function finalizeRemotePrompt(prompt: string, deps: {
    board?: PromptDecorator & { onTurnStart: (sourceIds?: string[]) => void };
    project: PromptDecorator;
    sourceIds?: string[];
}): Promise<string> {
    const command = parseSpecialCommand(prompt).type;
    if (command === 'compact' || command === 'clear') return prompt;
    deps.board?.onTurnStart(deps.sourceIds);
    const text = deps.board ? await deps.board.decorate(prompt) : prompt;
    return deps.project.decorate(text);
}
