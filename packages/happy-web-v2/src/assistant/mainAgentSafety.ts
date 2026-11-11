/**
 * Main agent safety setting (B-922, specs/2026-11-main-agent.md §4.4) — Web
 * side: capability check, draft ↔ KV section, and the owner-only save.
 *
 * The section schema and its fail-closed reading live in happy-wire
 * (`mainAgentSafety.ts`) so the CLI, the server and this page agree. A
 * section this build does not understand is shown as strict and never
 * rewritten silently.
 */

import {
    effectiveSafetyPolicy,
    parseMainAgentSafety,
    PRESET_POLICIES,
    SAFETY_POLICY_KEYS,
    type MainAgentSafety,
    type MainAgentSafetyPolicy,
    type SafetyPolicyKey,
    type SafetyPreset,
} from '@slopus/happy-wire';
import type { Machine } from '@/sync/storageTypes';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { daemonRpcFlagSupported } from '@/sync/closedTerminals';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/happyClientId';
import { MAIN_AGENT_CONFIG_KEY, decodeKvJson, encodeKvJson } from './mainAgent';

export { MAIN_AGENT_SAFETY_CAPABILITY } from '@slopus/happy-wire';

/** The machine's daemon runs the configurable safety setting (`daemonState.mainAgentSafety`). */
export function mainAgentSafetySupported(machine: Pick<Machine, 'daemonState'> | null | undefined): boolean {
    return daemonRpcFlagSupported(machine?.daemonState, 'mainAgentSafety');
}

export interface SafetyDraft {
    preset: SafetyPreset;
    overrides: Partial<MainAgentSafetyPolicy>;
    allowedTools: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the section out of the whole config value. `unreadable` = present but not understood (shown strict, not editable as-is). */
export function readSafety(configRaw: unknown): { draft: SafetyDraft; unreadable: boolean; present: boolean } {
    const section = isObj(configRaw) ? configRaw.safety : undefined;
    const { safety, failedClosed } = parseMainAgentSafety(section);
    return { draft: { preset: safety.preset, overrides: { ...safety.overrides }, allowedTools: [...safety.allowedTools] }, unreadable: failedClosed, present: section !== undefined };
}

export function draftPolicy(draft: SafetyDraft): MainAgentSafetyPolicy {
    return effectiveSafetyPolicy(draft);
}

/** Set one item; an item equal to the preset's value is not an override. */
export function setDraftItem<K extends SafetyPolicyKey>(draft: SafetyDraft, key: K, value: MainAgentSafetyPolicy[K]): SafetyDraft {
    const overrides = { ...draft.overrides };
    if (PRESET_POLICIES[draft.preset][key] === value) delete overrides[key];
    else overrides[key] = value;
    return { ...draft, overrides };
}

/** Picking a preset starts from that preset (the advanced items reset). */
export function setDraftPreset(draft: SafetyDraft, preset: SafetyPreset): SafetyDraft {
    return { ...draft, preset, overrides: {} };
}

export function overrideCount(draft: SafetyDraft): number {
    return SAFETY_POLICY_KEYS.filter((k) => draft.overrides[k] !== undefined).length;
}

export function sameDraft(a: SafetyDraft, b: SafetyDraft): boolean {
    const keys = (d: SafetyDraft) => JSON.stringify(SAFETY_POLICY_KEYS.map((k) => d.overrides[k] ?? null));
    return a.preset === b.preset && keys(a) === keys(b) && a.allowedTools.join('\n') === b.allowedTools.join('\n');
}

export function safetySection(draft: SafetyDraft): MainAgentSafety {
    const overrides: Partial<MainAgentSafetyPolicy> = {};
    for (const k of SAFETY_POLICY_KEYS) if (draft.overrides[k] !== undefined) (overrides as Record<string, unknown>)[k] = draft.overrides[k];
    return { v: 1, preset: draft.preset, overrides, allowedTools: [...draft.allowedTools] };
}

/** Whole config value with the new section; every other field kept. */
export function mergeSafetyIntoConfig(previous: unknown, draft: SafetyDraft, now: number): Record<string, unknown> {
    const base = isObj(previous) ? { ...previous } : {};
    return { ...base, v: 1, safety: safetySection(draft), updatedAt: now };
}

export type SafetySaveResult =
    | { ok: true; raw: Record<string, unknown>; version: number }
    | { ok: false; error: 'owner_only' | 'conflict' | 'failed' };

/**
 * Owner-only write. Not through `kvMutate`: the server refuses a loosening
 * from a non-browser login with 422 `main_agent_config_owner_only`, which must
 * surface as a message — not be retried, and not read as a dead login.
 * On a version conflict: re-merge onto the newer value once.
 */
export async function saveMainAgentSafety(
    creds: AuthCredentials,
    draft: SafetyDraft,
    current: { raw: unknown; version: number },
    fetchImpl: typeof fetch = fetch,
): Promise<SafetySaveResult> {
    let { raw, version } = current;
    for (let attempt = 0; attempt < 2; attempt++) {
        const merged = mergeSafetyIntoConfig(raw, draft, Date.now());
        let response: Response;
        try {
            response = await fetchImpl(`${getServerUrl()}/v1/kv`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${creds.token}`, 'Content-Type': 'application/json', 'X-Happy-Client': getHappyClientId() },
                body: JSON.stringify({ mutations: [{ key: MAIN_AGENT_CONFIG_KEY, value: encodeKvJson(merged), version }] }),
            });
        } catch {
            return { ok: false, error: 'failed' };
        }
        if (response.status === 422) {
            const body = await response.json().catch(() => null) as { error?: unknown } | null;
            return { ok: false, error: body?.error === 'main_agent_config_owner_only' ? 'owner_only' : 'failed' };
        }
        if (response.status === 409) {
            const body = await response.json().catch(() => null) as { errors?: Array<{ version: number; value: string | null }> } | null;
            const err = body?.errors?.[0];
            if (!err) return { ok: false, error: 'conflict' };
            raw = err.value ? decodeKvJson(err.value) : null;
            version = err.version;
            continue;
        }
        if (!response.ok) return { ok: false, error: 'failed' };
        const body = await response.json().catch(() => null) as { results?: Array<{ version: number }> } | null;
        return { ok: true, raw: merged, version: body?.results?.[0]?.version ?? version + 1 };
    }
    return { ok: false, error: 'conflict' };
}
