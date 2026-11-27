import { z } from 'zod';

/**
 * B-981 global model channels.
 *
 * An operator lists model endpoints once in the server's instance config
 * (`globalModelChannels`); every member's daemon fetches the channels its
 * account may use from `GET /v1/model-channels` and lists each one as a
 * read-only account `global-<id>` on that machine. Machine tokens get the
 * channel key (the daemon stores it 0600 like any account key); Web tokens
 * never do.
 *
 * Compatibility: an older server answers 404 (= no channels); an older CLI
 * never asks; an older Web ignores `AgentProfileSummary.scope`.
 */

export const MODEL_CHANNELS_PATH = '/v1/model-channels';

/** Account-id prefix of a materialized channel (`global-<channel id>`). */
export const GLOBAL_ACCOUNT_ID_PREFIX = 'global-';

/** `AgentProfileSummary.scope` of a channel account. Absent = a machine-local account. */
export const AGENT_PROFILE_SCOPE_GLOBAL = 'global';

/** Channel ids: lowercase, digits and '-', 1–32, so `global-<id>` is a valid account id. */
export const ModelChannelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const ModelChannelSchema = z.object({
    id: ModelChannelIdSchema,
    label: z.string().min(1).max(60),
    agent: z.enum(['claude', 'codex']),
    baseUrl: z.string().regex(/^https?:\/\/[^\s]+$/i).max(2048),
    models: z.array(z.string().min(1).max(200)).min(1).max(50),
    contextWindows: z.record(z.string(), z.number().int().positive()).optional(),
    /** Codex only: wire API of the endpoint (default responses). */
    wireApi: z.enum(['responses', 'chat']).optional(),
    /** Machine tokens only. */
    apiKey: z.string().min(1).max(4096).optional(),
});
export type ModelChannel = z.infer<typeof ModelChannelSchema>;

export const ModelChannelsResponseSchema = z.object({
    /** Stable hash of the visible set (keys included for machine callers); unchanged → nothing to rewrite. */
    revision: z.string(),
    channels: z.array(z.unknown()),
});
export type ModelChannelsResponse = { revision: string; channels: ModelChannel[] };

/** Tolerant parse: a malformed channel is dropped, never the whole answer. */
export function parseModelChannelsResponse(raw: unknown): ModelChannelsResponse | null {
    const parsed = ModelChannelsResponseSchema.safeParse(raw);
    if (!parsed.success) return null;
    const channels: ModelChannel[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.data.channels) {
        const channel = ModelChannelSchema.safeParse(entry);
        if (!channel.success || seen.has(channel.data.id)) continue;
        seen.add(channel.data.id);
        channels.push(channel.data);
    }
    return { revision: parsed.data.revision, channels };
}

export function globalAccountId(channelId: string): string {
    return `${GLOBAL_ACCOUNT_ID_PREFIX}${channelId}`;
}

/** True for a summary the daemon marked as a global channel (read-only on the machine). */
export function isGlobalAgentProfile(summary: { scope?: string | null } | null | undefined): boolean {
    return summary?.scope === AGENT_PROFILE_SCOPE_GLOBAL;
}
