import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMessageMode } from './messageMode';
import {
    applyProviderEnv,
    expandHome,
    loadSessionProvider,
    parseProvidersFile,
    readSessionProviders,
    resolveSessionProvider,
    updateBindings,
    writeSessionProviders,
} from './providerBinding';

const providers = parseProvidersFile({
    profiles: {
        llmhub: { name: 'LLM Hub', baseUrl: 'https://llm-hub.example/', apiKeyFile: '~/.config/llm-hub/key', models: ['kimi-k3', 'deepseek'] },
        broken: { baseUrl: 'not-a-url', apiKeyFile: 'x' },
    },
});

describe('B-794 provider binding', () => {
    it('an unbound session resolves to null and never reads a key (unchanged path)', () => {
        const readKey = () => { throw new Error('must not read'); };
        expect(resolveSessionProvider('other', { providers, bindings: { s1: { profile: 'llmhub', model: 'kimi-k3' } }, readKey })).toBeNull();
    });

    it('a bound session gets base URL, token and the model in every slot', () => {
        const r = resolveSessionProvider('s1', { providers, bindings: { s1: { profile: 'llmhub', model: 'kimi-k3' } }, readKey: () => 'sk-hub-x\n' })!;
        expect(r.env).toEqual({
            ANTHROPIC_BASE_URL: 'https://llm-hub.example',
            ANTHROPIC_AUTH_TOKEN: 'sk-hub-x',
            ANTHROPIC_MODEL: 'kimi-k3',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3',
            ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k3',
            CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3',
        });
    });

    it('applyProviderEnv strips inherited credentials and keeps unrelated env', () => {
        const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b', PATH: '/bin', HAPPY_MANAGED: '1' };
        const r = resolveSessionProvider('s1', { providers, bindings: { s1: { profile: 'llmhub', model: 'deepseek' } }, readKey: () => 'k' })!;
        applyProviderEnv(env, r);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(env.PATH).toBe('/bin');
        expect(env.HAPPY_MANAGED).toBe('1');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
        expect(env.ANTHROPIC_MODEL).toBe('deepseek');
    });

    it('fails loudly on an unknown profile or empty key', () => {
        expect(() => resolveSessionProvider('s1', { providers, bindings: { s1: { profile: 'nope', model: 'm' } }, readKey: () => 'k' })).toThrow(/not defined/);
        expect(() => resolveSessionProvider('s1', { providers, bindings: { s1: { profile: 'llmhub', model: 'm' } }, readKey: () => '  ' })).toThrow(/empty/);
    });

    it('drops malformed profiles', () => {
        expect(Object.keys(providers.profiles)).toEqual(['llmhub']);
    });

    it('expandHome only expands a leading ~', () => {
        expect(expandHome('~/k', '/h')).toBe('/h/k');
        expect(expandHome('/a/~/k', '/h')).toBe('/a/~/k');
    });

    it('file round trip: write 0600, read back, load with key file; no binding file = null', () => {
        const home = mkdtempSync(join(tmpdir(), 'vh-b794-'));
        expect(loadSessionProvider(home, 's1')).toBeNull();
        const keyFile = join(home, 'key');
        writeFileSync(keyFile, 'sk-file\n');
        writeFileSync(join(home, 'providers.json'), JSON.stringify({ profiles: { hub: { baseUrl: 'https://h', apiKeyFile: keyFile, models: ['m1'] } } }));
        writeSessionProviders(home, updateBindings({}, 's1', { profile: 'hub', model: 'm1' }));
        expect(statSync(join(home, 'session-providers.json')).mode & 0o777).toBe(0o600);
        expect(readSessionProviders(home)).toEqual({ s1: { profile: 'hub', model: 'm1' } });
        expect(loadSessionProvider(home, 's1')?.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-file');
        expect(loadSessionProvider(home, 's2')).toBeNull();
        writeSessionProviders(home, updateBindings(readSessionProviders(home), 's1', null));
        expect(JSON.parse(readFileSync(join(home, 'session-providers.json'), 'utf8'))).toEqual({});
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
