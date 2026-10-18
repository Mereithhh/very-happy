/**
 * B-628: a message the web sends with `delivery: 'steer'` (the「Steer」button on a queued
 * message) goes into the running Codex turn through `turn/steer` instead of waiting behind
 * it — the Codex twin of runClaude's trySteer. Anything short of `steered` (nothing running,
 * this codex has no turn/steer, Codex refused, transport) means the message was not taken, and
 * the caller queues it so it becomes the next turn exactly as before.
 *
 * The turn keeps its model / approval policy; the overrides the message carried were already
 * folded into the runner's current* settings and apply from the next turn/start.
 */
import type { CodexSteerOutcome } from './codexAppServerClient';

export type StagedSteerAttachment = { path: string; mimeType: string };

export type CodexSteerDeps<A, S extends StagedSteerAttachment> = {
    /** The runner owns a turn right now (dequeued, not aborting, not exiting). */
    ownsTurn: () => boolean;
    steer: (input: { text: string; images: string[]; clientId?: string }) => Promise<CodexSteerOutcome>;
    /** Copies the attachments into the session's attachment directory (a second staging happens when the queue dequeues them). */
    stage: (attachments: A[]) => Promise<S[]>;
    /** Text form of the message with the staged files appended as a manifest. */
    withAttachments: (text: string, staged: S[]) => string;
    /** Removes a staged copy that will not be used (the message fell back to the queue). */
    unlink: (path: string) => Promise<void>;
    isImage: (file: S) => boolean;
    onSteered: (text: string) => void;
    log: (message: string) => void;
};

/** True when Codex took the message into the running turn; false means "queue it". */
export async function steerIntoRunningTurn<A, S extends StagedSteerAttachment>(
    deps: CodexSteerDeps<A, S>,
    text: string,
    attachments: A[] | undefined,
    localKey: string | undefined,
): Promise<boolean> {
    if (!deps.ownsTurn()) return false;
    const staged = attachments?.length ? await deps.stage(attachments) : [];
    try {
        const outcome = await deps.steer({
            text: deps.withAttachments(text, staged),
            images: staged.filter((file) => deps.isImage(file)).map((file) => file.path),
            clientId: localKey,
        });
        if (outcome === 'steered') {
            deps.onSteered(text);
            return true;
        }
        deps.log(`[Codex] Steer not taken (${outcome}); queuing the message for the next turn`);
    } catch (error) {
        deps.log(`[Codex] Steer failed; queuing the message for the next turn: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Promise.all(staged.map((file) => deps.unlink(file.path).catch(() => undefined)));
    return false;
}
