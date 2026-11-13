import { describe, expect, it, vi } from 'vitest';
import { PRESET_POLICIES } from '@slopus/happy-wire';
import { decodeKvJson, encodeKvJson, mergeMainAgentConfig } from './mainAgent';
import {
    draftPolicy, mainAgentSafetySupported, mergeSafetyIntoConfig, overrideCount, readSafety, sameDraft, saveMainAgentSafety,
    setDraftItem, setDraftPreset,
} from './mainAgentSafety';

vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://server.example' }));
vi.mock('@/sync/happyClientId', () => ({ getHappyClientId: () => 'web/test' }));

const creds = { token: 't', secret: 's' } as any;
const resp = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

describe('B-922 main agent safety (web)', () => {
    it('no section reads as loose (the default); a section from a newer build reads strict and unreadable', () => {
        expect(readSafety({ v: 1, skillRoots: [] })).toMatchObject({ draft: { preset: 'loose', overrides: {}, allowedTools: [] }, unreadable: false, present: false });
        const future = readSafety({ v: 1, safety: { v: 2, preset: 'loose' } });
        expect(future.unreadable).toBe(true);
        expect(draftPolicy(future.draft)).toEqual(PRESET_POLICIES.strict);
    });

    it('an item equal to the preset is not an override; a preset change resets the advanced items', () => {
        let d = readSafety(null).draft;
        d = setDraftItem(d, 'bash', true);
        d = setDraftItem(d, 'outbound', 'allow'); // = loose
        expect(d.overrides).toEqual({ bash: true });
        expect(overrideCount(d)).toBe(1);
        d = setDraftPreset(d, 'standard');
        expect(d).toEqual({ preset: 'standard', overrides: {}, allowedTools: [] });
        expect(sameDraft(d, { preset: 'standard', overrides: {}, allowedTools: [] })).toBe(true);
    });

    it('writes keep every other field; the skills save keeps the safety section', () => {
        const prev = { v: 1, skillRoots: ['~/s'], deniedTools: ['mcp__*__*x*'], quietHours: [1] };
        const merged = mergeSafetyIntoConfig(prev, { preset: 'strict', overrides: { dispatchExternal: 'direct' }, allowedTools: ['mcp__a__b'] }, 5);
        expect(merged).toEqual({ ...prev, safety: { v: 1, preset: 'strict', overrides: { dispatchExternal: 'direct' }, allowedTools: ['mcp__a__b'] }, updatedAt: 5 });
        expect(mergeMainAgentConfig(merged, { skillRoots: [], deniedTools: [] }, 6).safety).toEqual(merged.safety);
    });

    it('capability: shown only when the daemon advertises mainAgentSafety', () => {
        expect(mainAgentSafetySupported({ daemonState: { startedAt: 1, mainAgentSafety: { rpcAvailable: true, detectedAt: 2 } } } as any)).toBe(true);
        expect(mainAgentSafetySupported({ daemonState: { startedAt: 1, mainAgentGates: { rpcAvailable: true, detectedAt: 2 } } } as any)).toBe(false);
        expect(mainAgentSafetySupported(null)).toBe(false);
    });

    it('owner-only refusal (422) surfaces as owner_only, without retries', async () => {
        const fetchImpl = vi.fn(async () => resp(422, { error: 'main_agent_config_owner_only', key: 'vh.main-agent-config.v1' }));
        const res = await saveMainAgentSafety(creds, { preset: 'loose', overrides: {}, allowedTools: [] }, { raw: null, version: -1 }, fetchImpl as any);
        expect(res).toEqual({ ok: false, error: 'owner_only' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('version conflict: re-merges onto the newer value once', async () => {
        const newer = { v: 1, skillRoots: ['~/new'] };
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(resp(409, { success: false, errors: [{ key: 'k', error: 'version-mismatch', version: 4, value: encodeKvJson(newer) }] }))
            .mockResolvedValueOnce(resp(200, { success: true, results: [{ key: 'k', version: 5 }] }));
        const res = await saveMainAgentSafety(creds, { preset: 'strict', overrides: {}, allowedTools: [] }, { raw: { v: 1 }, version: 2 }, fetchImpl as any);
        expect(res.ok && res.version).toBe(5);
        const sent = JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).mutations[0];
        expect(sent.version).toBe(4);
        expect(decodeKvJson(sent.value)).toMatchObject({ skillRoots: ['~/new'], safety: { v: 1, preset: 'strict' } });
    });
});
