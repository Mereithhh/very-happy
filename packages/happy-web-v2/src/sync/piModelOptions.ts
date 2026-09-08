import type { ModelMode } from '@/components/modelModeOptions';
import { getPiModelModes, mapMetadataOptions } from '@/components/modelModeOptions';
import { isPiAgent } from './agentDefaults';

/**
 * Model options Settings → Agents can offer for pi (B-370).
 *
 * pi has no hardcodable model list — its registry is whatever providers the
 * machine's pi is configured with — and there is no session on the settings
 * page to ask. What we do have is every pi session on the account: pi-acp
 * publishes the registry it started with in `metadata.models` (probed 23/23
 * sessions on 2026-09-07: e.g. `zai/glm-5.3`, `llm-hub/claude-fable-5-1`). So
 * the picker is `default` (don't send a model; the machine's own pi config
 * applies) followed by the union of those lists, most recently updated session
 * first so a machine whose registry changed wins over stale ones.
 *
 * Pure so it can be tested without the store; the settings page feeds it
 * `useAllSessions()` (already newest-first) and memoises.
 */
export type PiModelSource = {
    updatedAt: number;
    metadata?: {
        flavor?: string | null;
        models?: Array<{ code: string; value: string; description?: string | null }> | null;
    } | null;
};

export function collectPiModelOptions(
    sessions: readonly PiModelSource[],
    /** Keys that must stay pickable even if no session published them (the saved override). */
    keep: readonly (string | null | undefined)[] = [],
): ModelMode[] {
    const out: ModelMode[] = [...getPiModelModes()];
    const seen = new Set(out.map((option) => option.key));
    const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const session of ordered) {
        if (!isPiAgent(session.metadata?.flavor)) continue;
        for (const option of mapMetadataOptions(session.metadata?.models)) {
            if (seen.has(option.key)) continue;
            seen.add(option.key);
            out.push(option);
        }
    }
    for (const key of keep) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, name: key, description: null });
    }
    return out;
}
