import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './accountService';
import type { CodexRpc } from './codexLogin';
import { accountCodexHomePath, readAccountsFileV2, readSessionBindings } from './store';

function setup(rpcHandlers: Record<string, (p: any) => any> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'vh-b850b-svc-'));
    const home = join(root, 'happy');
    const codexHome = join(root, 'codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), '[model_providers.llmhub]\nname = "LLM Hub"\nbase_url = "https://hub/v1"\nenv_key = "LLMHUB_API_KEY"\n');
    let notify: (m: string, p: any) => void = () => {};
    const spawnCodexRpc = vi.fn((overlay: string): CodexRpc => ({
        request: async (method, params) => {
            if (method === 'account/login/start') writeFileSync(join(overlay, 'auth.json'), '{"tokens":"new"}');
            const h = rpcHandlers[method];
            if (!h) throw new Error(`no ${method}`);
            return h(params);
        },
        onNotification: (cb) => { notify = cb; },
        onExit: () => {},
        close: () => {},
    }));
    const check = vi.fn(async () => ({ status: 'ok', at: 7 }));
    const sessionAgent = vi.fn((id: string) => (id === 'cx-session' ? 'codex' : id === 'cl-session' ? 'claude' : undefined));
    const svc = new AccountService({ home, env: { CODEX_HOME: codexHome, HUB_KEY: 'k' }, now: () => 5, daemonPid: 9, check, spawnCodexRpc, sessionAgent });
    return { home, codexHome, svc, check, spawnCodexRpc, notify: (m: string, p: any) => notify(m, p) };
}

const DEVICE = { type: 'chatgptDeviceCode', loginId: 'cx', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-9' };

describe('B-850b account service — Codex', () => {
    it('add codex-provider on a config.toml provider: checked, listed with provider; state lists the machine providers', async () => {
        const { svc, check } = setup();
        const a = await svc.add({ agent: 'codex', kind: 'codex-provider', label: 'Hub', provider: 'llmhub', models: ['kimi'], key: { source: 'env', name: 'HUB_KEY' } });
        expect(a).toMatchObject({ id: 'hub', agent: 'codex', kind: 'codex-provider', provider: 'llmhub', keySource: 'env', keyRef: 'HUB_KEY', models: ['kimi'], status: 'ok' });
        expect(check).toHaveBeenCalledWith(expect.objectContaining({ provider: 'llmhub' }), 'k');
        expect(svc.state().codexProviders).toEqual([{ id: 'llmhub', name: 'LLM Hub', baseUrl: 'https://hub/v1', envKey: 'LLMHUB_API_KEY' }]);
        await expect(svc.add({ agent: 'codex', kind: 'codex-provider', label: 'X', provider: 'nope', key: { source: 'env', name: 'HUB_KEY' } })).rejects.toMatchObject({ code: 'not-found' });
        await expect(svc.add({ agent: 'codex', kind: 'codex-provider', label: 'X', key: { source: 'env', name: 'HUB_KEY' } })).rejects.toMatchObject({ code: 'invalid-params' });
    });

    it('default + bind: codex defaults are per agent; a Codex account never binds to a Claude session', async () => {
        const { svc } = setup();
        await svc.add({ agent: 'codex', kind: 'codex-provider', label: 'Hub', provider: 'llmhub', models: ['kimi', 'ds'], key: { source: 'env', name: 'HUB_KEY' } });
        expect(svc.setDefault('codex', 'hub').defaults).toEqual({ codex: 'hub' });
        expect(svc.resolveSpawnAccount('codex', undefined)).toBe('hub');
        expect(svc.resolveSpawnAccount('claude', undefined)).toBeNull();
        expect(() => svc.resolveSpawnAccount('claude', 'hub')).toThrow(/agent-mismatch/);
        await expect(svc.bind({ sessionId: 'cl-session', accountId: 'hub', restart: false })).rejects.toMatchObject({ code: 'invalid-params' });
        await expect(svc.bind({ sessionId: 'cx-session', accountId: 'hub', model: 'gpt-x', restart: false })).rejects.toMatchObject({ code: 'invalid-params' });
        expect(await svc.bind({ sessionId: 'cx-session', accountId: 'hub', model: 'ds', restart: false })).toEqual({ bound: true, restart: 'skipped' });
        expect(readSessionBindings(svc['home'])['cx-session']).toEqual({ account: 'hub', model: 'ds' });
    });

    it('ChatGPT sign-in: overlay prepared before Codex writes auth.json into it; success creates the account labelled by email', async () => {
        const { home, codexHome, svc, spawnCodexRpc, notify } = setup({ 'account/login/start': () => DEVICE, 'account/read': () => ({ account: { type: 'chatgpt', email: 'b@x.com', planType: 'plus' } }) });
        const s = await svc.loginStart({ agent: 'codex', kind: 'codex-chatgpt' });
        expect(s).toMatchObject({ state: 'waiting-code', flow: 'device-code', userCode: 'WXYZ-9', url: DEVICE.verificationUrl });
        const overlay = accountCodexHomePath(home, 'chatgpt');
        expect(spawnCodexRpc).toHaveBeenCalledWith(overlay, expect.objectContaining({ CODEX_HOME: overlay }));
        expect(existsSync(join(overlay, 'config.toml'))).toBe(true);
        expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('llmhub');
        expect(() => svc.loginSubmit({ loginId: s.loginId, code: 'x' })).toThrow(expect.objectContaining({ code: 'invalid-params' }));
        notify('account/login/completed', { loginId: 'cx', success: true });
        await vi.waitFor(() => expect(svc.loginStatus(s.loginId).state).toBe('succeeded'));
        expect(svc.loginStatus(s.loginId).account).toMatchObject({ id: 'chatgpt', label: 'b@x.com', email: 'b@x.com', planType: 'plus', kind: 'codex-chatgpt', status: 'ok', keySource: 'stored' });
        expect(readAccountsFileV2(home).accounts.chatgpt).toMatchObject({ agent: 'codex', kind: 'codex-chatgpt' });
        expect(existsSync(join(codexHome, 'auth.json'))).toBe(false);
        svc.dispose();
    });

    it('a NEW ChatGPT sign-in that fails leaves no half-made account or overlay', async () => {
        const { home, svc, notify } = setup({ 'account/login/start': () => DEVICE });
        const s = await svc.loginStart({ agent: 'codex', kind: 'codex-chatgpt', label: 'Team B' });
        const overlay = accountCodexHomePath(home, 'team-b');
        expect(existsSync(overlay)).toBe(true);
        notify('account/login/completed', { loginId: 'cx', success: false, error: 'denied' });
        expect(svc.loginStatus(s.loginId)).toMatchObject({ state: 'failed', error: 'denied' });
        expect(existsSync(overlay)).toBe(false);
        expect(readAccountsFileV2(home).accounts).toEqual({});
        svc.dispose();
    });
});
