import { createHash } from 'node:crypto';
import type { ModelChannel, ModelChannelsResponse } from '@slopus/happy-wire';
import type { GlobalModelChannelConfig, InstanceConfig } from '@/app/instance/instanceConfig';
import type { RequestTokenKind } from '@/app/auth/tokenKind';

/**
 * B-981 global model channels: which of the operator's channels an account
 * sees, and in what form. Pure.
 *
 * - disabled channels and channels whose audience does not list the account
 *   are left out (the daemon then removes them from the machine);
 * - `apiKey` only goes to machine tokens (the daemon that runs sessions);
 *   a Web (human) token gets the list without any key.
 */
export function visibleModelChannels(config: Pick<InstanceConfig, 'globalModelChannels'>, accountId: string, tokenKind: RequestTokenKind): ModelChannelsResponse {
    const channels: ModelChannel[] = config.globalModelChannels
        .filter(c => c.enabled && audienceIncludes(c, accountId))
        .map(c => ({
            id: c.id,
            label: c.label,
            agent: c.agent,
            baseUrl: c.baseUrl,
            models: c.models,
            ...(c.contextWindows && Object.keys(c.contextWindows).length > 0 ? { contextWindows: c.contextWindows } : {}),
            ...(c.agent === 'codex' && c.wireApi ? { wireApi: c.wireApi } : {}),
            ...(tokenKind === 'machine' ? { apiKey: c.apiKey } : {}),
        }));
    return { revision: modelChannelsRevision(channels), channels };
}

function audienceIncludes(channel: GlobalModelChannelConfig, accountId: string): boolean {
    return channel.audience === 'all' || channel.audience.accounts.includes(accountId);
}

/** A hash of exactly what the caller receives: same answer → same revision, any change (key rotation included) → a new one. */
export function modelChannelsRevision(channels: ModelChannel[]): string {
    return createHash('sha256').update(JSON.stringify(channels)).digest('hex').slice(0, 32);
}
