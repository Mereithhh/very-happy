/**
 * B-850c P1 (QA30): a daemon reply that IS a login status / account must reach
 * the dialog even when it carries `error` — a failed sign-in is
 * `{ loginId, state: 'failed', error }`; treating it as an RPC failure left the
 * dialog on 「验证中…」 until the 10-minute expiry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ reply: undefined as unknown }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: vi.fn(async () => rpc.reply) } }));

import { agentProfileAdd, agentProfileLoginCancel, agentProfileLoginStart, agentProfileLoginStatus, agentProfileLoginSubmit, agentProfileTest, agentProfileRemove } from './agentProfileOps';

const failed = { loginId: 'l1', state: 'failed', error: 'OAuth error: Invalid code. Please make sure the full code was copied' };

describe('agent-profile RPC replies that carry error', () => {
    beforeEach(() => { rpc.reply = undefined; });

    it('a failed login status is a status (state + reason), for every login RPC', async () => {
        rpc.reply = failed;
        for (const call of [
            () => agentProfileLoginStatus('m', 'l1'),
            () => agentProfileLoginSubmit('m', 'l1', 'bad'),
            () => agentProfileLoginStart('m', { agent: 'claude', kind: 'claude-subscription', label: 'A' }),
            () => agentProfileLoginCancel('m', 'l1'),
        ]) {
            const result = await call();
            expect(result).toEqual({ ok: true, data: expect.objectContaining({ loginId: 'l1', state: 'failed', error: failed.error }) });
        }
    });

    it('a real RPC error (no status) is still a failure with its code', async () => {
        rpc.reply = { error: 'no login "l1"', code: 'login-not-found' };
        expect(await agentProfileLoginStatus('m', 'l1')).toMatchObject({ ok: false, code: 'login-not-found' });
        rpc.reply = { error: 'Method not found' };
        expect(await agentProfileLoginStart('m', { agent: 'codex', kind: 'codex-chatgpt' })).toMatchObject({ ok: false, unsupported: true });
    });

    it('a test that failed returns the account (bad status), not an RPC failure', async () => {
        rpc.reply = { account: { id: 'h1', label: 'hub', agent: 'claude', kind: 'claude-api', status: 'invalid', statusDetail: '401' }, error: 'key rejected' };
        expect(await agentProfileTest('m', 'h1')).toMatchObject({ ok: true, data: { status: 'invalid', statusDetail: '401' } });
        // add saves even when its test fails (wire v1): the account comes back
        expect(await agentProfileAdd('m', { agent: 'codex', kind: 'codex-provider', label: 'x', provider: 'p', models: [], key: { source: 'file', path: '/k' } })).toMatchObject({ ok: true, data: { status: 'invalid' } });
        rpc.reply = { error: 'gone', code: 'not-found' };
        expect(await agentProfileTest('m', 'h1')).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('remove in-use stays a failure carrying the sessions', async () => {
        rpc.reply = { error: 'in use', code: 'in-use', sessions: ['s1'] };
        expect(await agentProfileRemove('m', 'a1')).toMatchObject({ ok: false, code: 'in-use', sessions: ['s1'] });
    });
});
