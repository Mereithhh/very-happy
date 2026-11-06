/**
 * B-893: a model name typed into the run-setup picker (Claude / Codex). The
 * pick is this session's own (like any other pick); the last few typed names
 * are remembered in this browser per agent so they come back as list entries.
 * Nothing here checks the name against a catalog — the CLI / upstream decides,
 * and its refusal surfaces in the session (Claude: setModel's
 * 「not a recognized model id」 notice, model_not_found's retired notice).
 */
import { create } from 'zustand';

/** Without the `[1m]` suffix. */
export const CUSTOM_MODEL_MAX_LENGTH = 64;
export const RECENT_CUSTOM_MODELS_MAX = 3;
const STORAGE_PREFIX = 'vh.recentCustomModels.';

/**
 * What every path that carries a model accepts: the daemon's resume precheck
 * (happy-cli daemon/resumePrecheck.ts) is the strictest — letters, digits,
 * `. _ : -`, ≤64, optional `[1m]`. A name outside it would be dropped on
 * resume, i.e. silently swapped for the default, so it is refused here.
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LONG_CONTEXT = '[1m]';

export type CustomModelCheck = { ok: true; value: string } | { ok: false; reason: 'empty' | 'tooLong' | 'chars' | 'reserved' };

export function checkCustomModelName(raw: string): CustomModelCheck {
    const value = raw.trim();
    const base = value.endsWith(LONG_CONTEXT) ? value.slice(0, -LONG_CONTEXT.length) : value;
    if (!base) return { ok: false, reason: 'empty' };
    if (base.length > CUSTOM_MODEL_MAX_LENGTH) return { ok: false, reason: 'tooLong' };
    if (!MODEL_NAME.test(base)) return { ok: false, reason: 'chars' };
    // The picker's own sentinels mean something else on the wire.
    if (base === 'latest' || base === 'default') return { ok: false, reason: 'reserved' };
    return { ok: true, value };
}

/** Most recent first, deduped, capped. */
export function rememberCustomModel(list: readonly string[], value: string, max = RECENT_CUSTOM_MODELS_MAX): string[] {
    return [value, ...list.filter((item) => item !== value)].slice(0, max);
}

function readRecent(agent: string): string[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + agent) ?? '[]');
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === 'string' && checkCustomModelName(item).ok).slice(0, RECENT_CUSTOM_MODELS_MAX)
            : [];
    } catch {
        return [];
    }
}

type RecentCustomModelsState = {
    byAgent: Record<string, string[]>;
    remember: (agent: string, value: string) => void;
};

/** Agents whose picker takes a typed name (B-893). */
export const CUSTOM_MODEL_AGENTS = ['claude', 'codex'] as const;

export const recentCustomModelsStore = create<RecentCustomModelsState>((set, get) => ({
    byAgent: Object.fromEntries(CUSTOM_MODEL_AGENTS.map((agent) => [agent, readRecent(agent)])),
    remember: (agent, value) => {
        const next = rememberCustomModel(get().byAgent[agent] ?? [], value);
        try { localStorage.setItem(STORAGE_PREFIX + agent, JSON.stringify(next)); } catch { /* memory only */ }
        set((state) => ({ byAgent: { ...state.byAgent, [agent]: next } }));
    },
}));

const NONE: readonly string[] = Object.freeze([]);

export function useRecentCustomModels(agent: string | null): readonly string[] {
    return recentCustomModelsStore((state) => (agent ? state.byAgent[agent] : undefined)) ?? NONE;
}
