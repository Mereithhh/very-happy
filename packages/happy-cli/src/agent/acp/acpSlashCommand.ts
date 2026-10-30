import { COMPACT_UNSUPPORTED_NOTICE, compactCommandText } from '@/parsers/specialCommands';

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

export type AcpUserTextRoute =
  /** Answered by Very Happy; nothing is queued. */
  | { kind: 'unsupported'; notice: string }
  /** An agent command: a turn of its own, never steered, never joined with other messages. */
  | { kind: 'command'; text: string }
  | { kind: 'prompt'; text: string };

/**
 * Where a web message goes on an ACP session. `/compact` (also as a phone
 * keyboard types it: ／compact, /Compact) is canonicalised; when the agent has
 * listed its commands (`available_commands_update`) and compaction is not
 * among them, Very Happy says so. Before the agent reported anything the
 * command is passed on, as before.
 */
export function routeAcpUserText(text: string, advertisedCommands: readonly string[] | null): AcpUserTextRoute {
  const compact = compactCommandText(text);
  if (compact !== null) {
    if (advertisedCommands && advertisedCommands.length > 0 && !advertisedCommands.includes('compact')) {
      return { kind: 'unsupported', notice: COMPACT_UNSUPPORTED_NOTICE };
    }
    return { kind: 'command', text: compact };
  }
  return isAgentSlashCommand(text) ? { kind: 'command', text } : { kind: 'prompt', text };
}
