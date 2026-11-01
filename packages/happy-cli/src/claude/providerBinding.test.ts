import { describe, expect, it } from 'vitest';
import { resolveMessageMode } from './messageMode';
import { expandHome, parseProvidersFile } from './providerBinding';

describe('B-794 v1 providers.json parsing (read-only since B-850a)', () => {
    it('drops malformed profiles, trims the base URL, keeps context windows', () => {
        const p = parseProvidersFile({ profiles: {
            hub: { baseUrl: 'https://h/', apiKeyFile: 'k', models: [{ id: 'kimi-k3', contextWindow: 262144 }, 'deepseek', { id: 'bad', contextWindow: -1 }] },
            broken: { baseUrl: 'not-a-url', apiKeyFile: 'x' },
        } });
        expect(Object.keys(p.profiles)).toEqual(['hub']);
        expect(p.profiles.hub.baseUrl).toBe('https://h');
        expect(p.profiles.hub.models).toEqual(['kimi-k3', 'deepseek', 'bad']);
        expect(p.profiles.hub.contextWindows).toEqual({ 'kimi-k3': 262144 });
    });

    it('expandHome only expands a leading ~', () => {
        expect(expandHome('~/k', '/h')).toBe('/h/k');
        expect(expandHome('/a/~/k', '/h')).toBe('/a/~/k');
    });
});

describe('B-794 pinned model in resolveMessageMode', () => {
    const ctx = { sandboxEnabled: false, isAssistantVariant: false, staleModeSnapshot: false };
    it('the bound model beats a composer model and drops the fallback', () => {
        const r = resolveMessageMode({ permissionMode: 'default' }, { model: 'opus', fallbackModel: 'sonnet' } as any, { ...ctx, pinnedModel: 'kimi-k3' });
        expect(r.mode.model).toBe('kimi-k3');
        expect(r.mode.fallbackModel).toBeUndefined();
        expect(r.next.model).toBe('kimi-k3');
    });
    it('without a pin the composer model still wins (unchanged)', () => {
        const r = resolveMessageMode({ permissionMode: 'default' }, { model: 'opus' } as any, ctx);
        expect(r.mode.model).toBe('opus');
    });
});
