import { parseCompact } from '@/parsers/specialCommands';

export type CodexCompactClient = {
    hasActiveThread(): boolean;
    compactThreadAndWait(): Promise<{ aborted: boolean; failed: boolean }>;
};

export type CodexCompactOutcome = 'completed' | 'failed' | 'aborted' | 'no-thread';

/**
 * Runs `/compact` on a Codex session through the app-server
 * (`thread/compact/start`) instead of sending the text to the model, which
 * answered that it cannot run it (Owner, 10-30). The service lines are the
 * ones Claude's /compact emits, so the web draws the same compaction marker
 * (screens/session/compaction.ts). An aborted compaction emits no end line:
 * the web shows that turn as interrupted.
 */
export async function runCodexCompact(command: string, deps: {
    client: CodexCompactClient;
    notify: (text: string) => void;
}): Promise<CodexCompactOutcome> {
    if (!deps.client.hasActiveThread()) {
        deps.notify('Compaction failed: there is no conversation to compact yet');
        return 'no-thread';
    }
    const instructions = parseCompact(command).originalMessage.slice('/compact'.length).trim();
    if (instructions) {
        deps.notify('Codex does not take compaction instructions; compacting the whole conversation');
    }
    deps.notify('Compaction started');
    try {
        const result = await deps.client.compactThreadAndWait();
        if (result.aborted) return 'aborted';
        if (result.failed) {
            deps.notify('Compaction failed: Codex could not compact the conversation');
            return 'failed';
        }
        deps.notify('Compaction completed');
        return 'completed';
    } catch (error) {
        deps.notify(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        return 'failed';
    }
}
