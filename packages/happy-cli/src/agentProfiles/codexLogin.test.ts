import { describe, expect, it, vi } from 'vitest';
import { CodexDeviceLoginManager, classifyChatgptRead, codexLoginEnv, type CodexRpc } from './codexLogin';

function fakeRpc(handlers: Record<string, (params: any) => any>) {
    let notify: (method: string, params: any) => void = () => {};
    let exit: (code: number | null) => void = () => {};
    const calls: Array<{ method: string; params: any }> = [];
    const rpc: CodexRpc = {
        request: async (method, params) => {
            calls.push({ method, params });
            const h = handlers[method];
            if (!h) throw new Error(`no ${method}`);
            return h(params);
        },
        onNotification: (cb) => { notify = cb; },
        onExit: (cb) => { exit = cb; },
        close: vi.fn(),
    };
    return { rpc, calls, notify: (m: string, p: any) => notify(m, p), exit: (c: number | null) => exit(c) };
}

const DEVICE = { type: 'chatgptDeviceCode', loginId: 'cx-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };

describe('B-850b Codex device-code sign-in', () => {
    it('start → waiting-code with url + userCode (device-code flow); completion → succeeded with email/plan', async () => {
        const f = fakeRpc({ 'account/login/start': () => DEVICE, 'account/read': () => ({ account: { type: 'chatgpt', email: 'b@x.com', planType: 'pro' } }) });
        const spawnRpc = vi.fn(() => f.rpc);
        const onSuccess = vi.fn(async (_id: string, info: any) => ({ id: 'b-x-com', label: info.email, agent: 'codex', kind: 'codex-chatgpt', status: 'ok', email: info.email }));
        const m = new CodexDeviceLoginManager({ spawnRpc, env: { OPENAI_API_KEY: 'sk-x', PATH: '/bin' }, newId: () => 'L1', now: () => 1000, onSuccess });
        const s = await m.start('/acct/codex-home');
        expect(s).toEqual({ loginId: 'L1', state: 'waiting-code', flow: 'device-code', url: DEVICE.verificationUrl, userCode: 'ABCD-1234', expiresAt: 1000 + 15 * 60_000 });
        expect(spawnRpc).toHaveBeenCalledWith('/acct/codex-home', expect.objectContaining({ CODEX_HOME: '/acct/codex-home' }));
        expect((spawnRpc.mock.calls[0] as any)[1].OPENAI_API_KEY).toBeUndefined();
        expect(f.calls[0]).toEqual({ method: 'account/login/start', params: { type: 'chatgptDeviceCode' } });
        await expect(m.start('/other')).rejects.toMatchObject({ code: 'login-busy' });
        f.notify('account/login/completed', { loginId: 'other-login', success: true });
        expect(m.status('L1').state).toBe('waiting-code');
        f.notify('account/login/completed', { loginId: 'cx-1', success: true });
        await vi.waitFor(() => expect(m.status('L1').state).toBe('succeeded'));
        expect(onSuccess).toHaveBeenCalledWith('L1', { email: 'b@x.com', planType: 'pro' });
        expect(m.status('L1').account).toMatchObject({ email: 'b@x.com' });
        m.dispose();
    });

    it('failure / cancel / app-server exit end the login with a reason; cancel tells Codex', async () => {
        const f = fakeRpc({ 'account/login/start': () => DEVICE, 'account/login/cancel': () => ({ status: 'canceled' }) });
        const onEnd = vi.fn();
        let n = 0;
        const m = new CodexDeviceLoginManager({ spawnRpc: () => f.rpc, env: {}, newId: () => `L${++n}`, onSuccess: vi.fn(), onEnd });
        await m.start('/h');
        f.notify('account/login/completed', { loginId: 'cx-1', success: false, error: 'denied' });
        expect(m.status('L1')).toMatchObject({ state: 'failed', error: 'denied' });
        await m.start('/h');
        expect(m.cancel('L2').state).toBe('canceled');
        expect(f.calls.some((c) => c.method === 'account/login/cancel' && c.params.loginId === 'cx-1')).toBe(true);
        await m.start('/h');
        f.exit(1);
        expect(m.status('L3')).toMatchObject({ state: 'failed', error: 'codex app-server exited' });
        expect(onEnd.mock.calls.map((c) => c[1])).toEqual(['failed', 'canceled', 'failed']);
        expect(() => m.status('nope')).toThrow(expect.objectContaining({ code: 'login-not-found' }));
        m.dispose();
    });

    it('start that gets no device code fails instead of hanging', async () => {
        const f = fakeRpc({ 'account/login/start': () => ({ type: 'chatgpt', authUrl: 'x', loginId: 'y' }) });
        const m = new CodexDeviceLoginManager({ spawnRpc: () => f.rpc, env: {}, newId: () => 'L', onSuccess: vi.fn() });
        expect(await m.start('/h')).toMatchObject({ state: 'failed', error: 'codex returned no device code' });
        m.dispose();
    });

    it('expires after 15 minutes', async () => {
        vi.useFakeTimers();
        try {
            const f = fakeRpc({ 'account/login/start': () => DEVICE });
            const m = new CodexDeviceLoginManager({ spawnRpc: () => f.rpc, env: {}, newId: () => 'L', onSuccess: vi.fn() });
            await m.start('/h');
            vi.advanceTimersByTime(15 * 60_000 + 1);
            expect(m.status('L').state).toBe('expired');
            m.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it('env + account/read classification', () => {
        expect(codexLoginEnv({ CODEX_API_KEY: 'k', HOME: '/u' }, '/c')).toEqual({ HOME: '/u', CODEX_HOME: '/c', RUST_LOG: 'warn' });
        expect(classifyChatgptRead({ account: { type: 'chatgpt', email: null } }, 1)).toEqual({ status: 'ok', at: 1 });
        expect(classifyChatgptRead({ account: null, requiresOpenaiAuth: true }, 1)).toMatchObject({ status: 'expired' });
    });
});
