/**
 * B-727: is this prompt a slash command for the ACP agent?
 *
 * pi-acp runs `/compact`, `/name`, `/session`… only when the prompt text
 * starts with the command and the command word ends at the first space
 * (pi-acp 0.0.33 `prompt()`: `message.trimStart().startsWith("/")`, command =
 * text up to the first " "). Anything Very Happy adds — the project prefix in
 * front, the todo note after a newline — turns the command into a chat
 * message. A path (`/tmp/x fails`) is not a command: the word must end at
 * whitespace or the end of the text.
 */
const SLASH_COMMAND = /^\/[A-Za-z][A-Za-z0-9_.:-]*(?:\s|$)/;

export function isAgentSlashCommand(message: unknown): boolean {
    return typeof message === 'string' && SLASH_COMMAND.test(message.trimStart());
}

/**
 * The text a dequeued message is sent to the ACP agent as. A slash command
 * goes verbatim (no project prefix, no todo note) and does not use up the
 * one-time todo note — the next real prompt still carries it.
 */
export async function buildAcpPrompt(message: string, opts: { todoNoteSent: boolean; todoNote: string; decorate: (message: string) => Promise<string> }): Promise<{ prompt: string; slashCommand: boolean }> {
    if (isAgentSlashCommand(message)) return { prompt: message, slashCommand: true };
    const projected = await opts.decorate(message);
    return { prompt: opts.todoNoteSent ? projected : `${projected}\n\n${opts.todoNote}`, slashCommand: false };
}
