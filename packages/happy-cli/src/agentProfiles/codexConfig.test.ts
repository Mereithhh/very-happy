import { describe, expect, it } from 'vitest';
import { accountProviderId, buildCodexProviderTable, parseCodexDefaultProvider, parseCodexProviders } from './codexConfig';

const TOML = `
model = "gpt-5.6-sol"
model_provider = "llmhub"
[model_providers.llmhub]
name = "LLM Hub"
base_url = "https://llm-hub.example/v1"
env_key = "LLMHUB_API_KEY"
wire_api = "responses"
requires_openai_auth = false
http_headers = { "X-Llmhub-Routing" = "codex" }
[model_providers."bad id"]
name = "x"
`;

describe('B-850b Codex config providers', () => {
    it('lists config.toml providers with their env_key name; bad ids and broken TOML are ignored', () => {
        const providers = parseCodexProviders(TOML);
        expect(providers.map((p) => p.id)).toEqual(['llmhub']);
        expect(providers[0]).toMatchObject({ name: 'LLM Hub', baseUrl: 'https://llm-hub.example/v1', envKey: 'LLMHUB_API_KEY' });
        expect(parseCodexProviders('model_providers = [')).toEqual([]);
        expect(parseCodexProviders(undefined)).toEqual([]);
    });

    it('the per-thread table drops every credential field and authenticates through the key-file command', () => {
        const [base] = parseCodexProviders(TOML);
        const table = buildCodexProviderTable({ base, label: 'Hub (acct)', nodePath: '/usr/bin/node', keyPath: '/k/key' });
        expect(table).not.toHaveProperty('env_key');
        expect(table).not.toHaveProperty('requires_openai_auth');
        expect(table).toMatchObject({ name: 'Hub (acct)', base_url: 'https://llm-hub.example/v1', wire_api: 'responses', http_headers: { 'X-Llmhub-Routing': 'codex' } });
        expect(table.auth).toEqual({ command: '/usr/bin/node', args: ['-e', expect.stringContaining('readFileSync(process.argv[1]'), '/k/key'] });
        expect(JSON.stringify(table)).not.toMatch(/LLMHUB_API_KEY/);
    });

    it('an own URL overrides the base, defaults to the responses wire API, and the id never collides with config ids', () => {
        expect(buildCodexProviderTable({ base: undefined, label: 'X', baseUrl: 'https://x/v1', nodePath: 'n', keyPath: 'k' })).toMatchObject({ base_url: 'https://x/v1', wire_api: 'responses' });
        expect(buildCodexProviderTable({ base: undefined, label: 'X', baseUrl: 'https://x/v1', wireApi: 'chat', nodePath: 'n', keyPath: 'k' }).wire_api).toBe('chat');
        expect(accountProviderId('llmhub')).toBe('vh-llmhub');
    });

    it('machine provider = config.toml model_provider, else Codex default openai', () => {
        expect(parseCodexDefaultProvider(TOML)).toBe('llmhub');
        expect(parseCodexDefaultProvider('model = "x"')).toBe('openai');
        expect(parseCodexDefaultProvider('broken = [')).toBe('openai');
    });
});
