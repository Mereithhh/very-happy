import { trimIdent } from '@/utils/trimIdent';

type ThreadOpts = {
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    model?: string;
};

type ResumeThreadClient = {
    resumeThread: (opts: ThreadOpts) => Promise<{ threadId: string; model: string }>;
    forkThread: (opts: ThreadOpts & { excludeTurns?: boolean }) => Promise<{ threadId: string; model: string }>;
};

type ResumeThreadSession = {
    updateMetadata: (handler: (currentMetadata: any) => any) => void;
    sendSessionEvent: (event: { type: 'message'; message: string; kind?: string }) => void;
};

type ResumeThreadMessageBuffer = {
    addMessage: (message: string, type: 'status') => void;
};

/**
 * B-934b: Codex ≥0.167 pins a thread to the provider it was created on and
 * refuses `thread/resume` from a process on another one — after an account
 * switch across providers (B-850), in both directions:
 *   `This chat uses model provider "vh-a", which is no longer configured. …`
 *   `This chat uses llmhub, but your current provider is vh-a. Switch to llmhub to continue.`
 * `thread/fork` of the same thread is accepted and records the current
 * provider, with the full history (vh-team-B-934b/probe).
 */
export function isThreadProviderMismatch(message: string): boolean {
    return /This chat uses .+(?:no longer configured|current provider is)/i.test(message);
}

export async function resumeExistingThread(opts: {
    client: ResumeThreadClient;
    session: ResumeThreadSession;
    messageBuffer: ResumeThreadMessageBuffer;
    threadId: string;
    cwd: string;
    mcpServers: Record<string, unknown>;
    /** B-850b: resume onto this model (an account switch); absent = the thread keeps its own. */
    model?: string;
    /** B-931: false = no "Resumed Codex thread" line in the chat (automatic in-place restarts). Default true. The provider-switch notice and `Codex error:` lines always show. */
    announce?: boolean;
    /** B-934b: the session's account, for the notices (absent = the machine's Codex login). */
    accountLabel?: string;
}): Promise<{ threadId: string; model: string; forkedFrom?: string }> {
    const threadOpts: ThreadOpts = {
        threadId: opts.threadId,
        cwd: opts.cwd,
        mcpServers: opts.mcpServers,
        ...(opts.model ? { model: opts.model } : {}),
    };
    const on = opts.accountLabel ? `account "${opts.accountLabel}"` : 'this machine\'s Codex login';
    let resumed: { threadId: string; model: string; forkedFrom?: string };
    try {
        resumed = await opts.client.resumeThread(threadOpts);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!isThreadProviderMismatch(reason)) {
            throw failVisibly(opts.session, `Codex error: could not resume this conversation (thread ${opts.threadId}): ${reason}`, 'codex-resume-failed');
        }
        // The turns are not needed (the transcript already has them) and can be huge (B-901).
        try {
            const forked = await opts.client.forkThread({ ...threadOpts, excludeTurns: true });
            if (!forked.threadId || forked.threadId === opts.threadId) throw new Error('Codex did not create a new thread');
            resumed = { ...forked, forkedFrom: opts.threadId };
        } catch (forkError) {
            const forkReason = forkError instanceof Error ? forkError.message : String(forkError);
            throw failVisibly(opts.session, `Codex error: this conversation cannot continue on ${on}. Codex keeps a chat on the provider it started on, and copying it failed (${forkReason}). Switch back to the previous account, or start a new session on this one.`, 'codex-provider-switch-failed');
        }
    }

    opts.session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        codexThreadId: resumed.threadId,
        ...(resumed.forkedFrom ? { codexThreadForkedFrom: resumed.forkedFrom } : {}),
    }));
    if (resumed.forkedFrom) {
        opts.messageBuffer.addMessage(`Continued thread ${trimIdent(resumed.forkedFrom)} as ${trimIdent(resumed.threadId)} (provider changed)`, 'status');
        opts.session.sendSessionEvent({
            type: 'message',
            message: `Now on ${on}, which uses a different model provider. Codex keeps a chat on the provider it started on, so this conversation continues in a copy with the same history (Codex thread ${resumed.threadId}, copied from ${resumed.forkedFrom}).`,
            kind: 'codex-provider-switch',
        });
    } else {
        opts.messageBuffer.addMessage(`Resumed thread ${trimIdent(resumed.threadId)}`, 'status');
        if (opts.announce !== false) {
            opts.session.sendSessionEvent({
                type: 'message',
                message: `Resumed Codex thread ${resumed.threadId}`,
            });
        }
    }
    return resumed;
}

/**
 * The wrapper exits after this; say why in the transcript first (runCodex
 * flushes before the session dies). `Codex error:` is what the Web shows as a
 * failure (serviceEvent.ts) — the turn used to read only "cancelled".
 */
function failVisibly(session: ResumeThreadSession, message: string, kind: string): Error {
    session.sendSessionEvent({ type: 'message', message, kind });
    return new Error(message);
}
