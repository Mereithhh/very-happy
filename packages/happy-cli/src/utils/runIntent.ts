/**
 * B-849b: the wrapper side of a session's run intent (happy-wire runIntent.ts,
 * specs/2026-10-session-run-intent.md). The wrapper is the only writer of
 * `metadata.modelIntent` / `metadata.effortIntent`; Claude and Codex record
 * them from each user message's meta and from the `session-run-intent` RPC,
 * which applies the choice to the wrapper's sticky state right away so a
 * message without meta (CLI send, team wake) runs what every device shows.
 */
import {
    nextRunIntents,
    readEffortIntent,
    readModelIntent,
    RUN_INTENT_RPC,
    RunIntentRequestSchema,
    type RunIntentRequest,
    type RunIntentResponse,
    type RunIntents,
} from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';

type MetadataSession = {
    getMetadata(): Metadata | null;
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
};

export function currentRunIntents(metadata: Pick<Metadata, 'modelIntent' | 'effortIntent'> | null | undefined): RunIntents {
    return {
        modelIntent: readModelIntent(metadata?.modelIntent) ?? null,
        effortIntent: readEffortIntent(metadata?.effortIntent) ?? null,
    };
}

/**
 * The metadata after recording `input` (message meta / RPC params) plus any
 * extra wrapper facts. Returns the same object when nothing changes.
 */
export function withRunIntents(metadata: Metadata, input: Record<string, unknown> | null | undefined, extra: Partial<Metadata> = {}): Metadata {
    const before = currentRunIntents(metadata);
    const after = nextRunIntents(before, input);
    const changedIntent = after.modelIntent !== before.modelIntent || after.effortIntent !== before.effortIntent
        || metadata.modelIntent === undefined || metadata.effortIntent === undefined;
    const changedExtra = Object.entries(extra).some(([key, value]) => (metadata as Record<string, unknown>)[key] !== value);
    if (!changedIntent && !changedExtra) return metadata;
    return { ...metadata, ...extra, modelIntent: after.modelIntent, effortIntent: after.effortIntent };
}

/** Record and publish; skips the write when nothing changed. */
export function recordRunIntents(session: MetadataSession, input: Record<string, unknown> | null | undefined, extra: Partial<Metadata> = {}): RunIntents {
    const current = session.getMetadata();
    if (current && withRunIntents(current, input, extra) === current) return currentRunIntents(current);
    session.updateMetadata((metadata) => withRunIntents(metadata, input, extra));
    return nextRunIntents(currentRunIntents(current), input);
}

type RpcRegistrar = { registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void };

/**
 * Register `session-run-intent`. `apply` moves the wrapper's sticky model /
 * effort (the keys present in the request) and returns extra facts to publish
 * with the intent (e.g. `stickyModel`).
 */
export function registerRunIntentRpc(rpc: RpcRegistrar, session: MetadataSession, apply: (request: RunIntentRequest) => Partial<Metadata> | void): void {
    rpc.registerHandler(RUN_INTENT_RPC, async (params: unknown): Promise<RunIntentResponse> => {
        const parsed = RunIntentRequestSchema.safeParse(params ?? {});
        if (!parsed.success) return { ok: false, error: 'invalid-request' };
        const extra = apply(parsed.data) ?? {};
        const intents = recordRunIntents(session, parsed.data, extra);
        return { ok: true, ...intents };
    });
}
