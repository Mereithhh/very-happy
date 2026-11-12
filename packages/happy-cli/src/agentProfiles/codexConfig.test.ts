import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { accountProviderId, buildCodexProviderTable, codexProcessProviderArgs, parseCodexDefaultProvider, parseCodexProviders, tomlInlineValue } from './codexConfig';

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

describe('B-934 process-level provider flags', () => {
    const table = buildCodexProviderTable({
        base: { id: 'corp', table: { name: 'Corp', base_url: 'https://old.example', env_key: 'CORP_KEY', http_headers: { 'X-Team': 'a "b"' }, request_max_retries: 3, supports_websockets: false } },
        label: 'Team 账号',
        baseUrl: 'https://api.example/v1',
        nodePath: '/opt/node/bin/node',
        keyPath: '/home/u/.happy/accounts/k e y',
    });

    it('an account provider becomes the process provider, with its table', () => {
        const args = codexProcessProviderArgs({ modelProvider: 'vh-team', config: { model_providers: { 'vh-team': table } } });
        expect(args.slice(0, 2)).toEqual(['-c', 'model_provider="vh-team"']);
        expect(args[2]).toBe('-c');
        const [key, value] = [args[3].slice(0, args[3].indexOf('=')), args[3].slice(args[3].indexOf('=') + 1)];
        expect(key).toBe('model_providers.vh-team');
        // What Codex parses back is the same table the thread config carries.
        expect((parse(`v = ${value}`) as { v: unknown }).v).toEqual(table);
        expect(args[3]).not.toContain('CORP_KEY');
    });

    it('a ChatGPT account pins the built-in provider without a table', () => {
        expect(codexProcessProviderArgs({ modelProvider: 'openai' })).toEqual(['-c', 'model_provider="openai"']);
    });

    it('machine login passes nothing (config.toml decides)', () => {
        expect(codexProcessProviderArgs({})).toEqual([]);
        expect(codexProcessProviderArgs({ modelProvider: 'bad id' })).toEqual([]);
    });

    it('inline TOML values round-trip', () => {
        const v = { s: 'a\\b"\n✓', n: 1.5, b: true, a: [1, 'x'], 'k.y': { z: 'q' } };
        expect((parse(`v = ${tomlInlineValue(v)}`) as { v: unknown }).v).toEqual(v);
    });
});
