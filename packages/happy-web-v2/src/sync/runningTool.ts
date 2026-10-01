import type { Message } from './typesMessage';

function isTaskNotificationText(text: string): boolean {
    return /^\s*<task-notification>/i.test(text);
}

/**
 * The newest still-running tool call of the CURRENT turn (input newest-first).
 * A tool call from an earlier turn that never closed (its wrapper restarted,
 * B-295) is not what is running now — taking it made the live bar say
 * 「执行 Bash · 300m」, timed from that old call, under a fresh message. A
 * queued or withdrawn input has not opened a turn; a task notification does
 * not end one (B-519).
 */
export function currentRunningTool(newestFirst: readonly Message[]): { name: string; startedAt: number } | null {
    let best: { name: string; startedAt: number } | null = null;
    for (const message of newestFirst) {
        if (message.kind === 'user-text' && message.inputState === undefined && !isTaskNotificationText(message.displayText ?? message.text)) break;
        if (message.kind !== 'tool-call') continue;
        const tool = message.tool;
        if (tool.state !== 'running') continue;
        const startedAt = tool.startedAt ?? tool.createdAt;
        if (!best || startedAt > best.startedAt) best = { name: tool.name, startedAt };
    }
    return best;
}
