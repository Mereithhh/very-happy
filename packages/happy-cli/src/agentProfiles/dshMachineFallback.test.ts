/**
 * B-960: a dsh session with no account chosen, on a machine whose own login
 * has no DeepSeek key, starts on a usable DeepSeek account instead.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { machineLoginFallbackAccount, pickMachineLoginFallback } from '@slopus/happy-wire';
import { AccountService } from './accountService';
import { dshHintContext, dshMachineLoginHasKey } from './dshAccount';
import { readAccountsFileV2 } from './store';
import { DSH_NO_KEY_ADD_ACCOUNT, dshFailureHint, dshMissingKeyHint } from '@/agent/acp/dshRunner';

const FAKE_KEY = ['sk', 'test', '0000'].join('-');

function service(machineKey: boolean, check: 'ok' | 'invalid' = 'ok') {
    const home = mkdtempSync(join(tmpdir(), 'vh-b960-'));
    let now = 100;
    const svc = new AccountService({
        home, env: {}, now: () => now++, daemonPid: 1,
        check: vi.fn(async () => ({ status: check, at: 7 })),
        dshMachineKey: () => machineKey,
    });
    const addDsh = (label: string) => svc.add({ agent: 'dsh', kind: 'dsh-api', label, key: { source: 'paste', value: FAKE_KEY } });
    return { home, svc, addDsh };
}

describe('B-960 resolveSpawnAccount: machine login without a key', () => {
    it('no key + an account + nothing chosen → the account (the reported state: default still machine login)', async () => {
        const { home, svc, addDsh } = service(false);
        const account = await addDsh('dsh coding');
        // The reported user added it before 0.2.223: no default was written.
        const file = readAccountsFileV2(home);
        delete file.defaults.dsh;
        writeFileSync(join(home, 'accounts.json'), JSON.stringify({ version: 2, accounts: file.accounts, defaults: file.defaults }));
        expect(svc.state().defaults.dsh).toBeUndefined();
        expect(svc.resolveSpawnAccount('dsh', undefined)).toBe(account.id);
    });

    it('explicit machine login stays the machine login, even without a key', async () => {
        const { svc, addDsh } = service(false);
        await addDsh('a');
        expect(svc.resolveSpawnAccount('dsh', null)).toBeNull();
    });

    it('machine has a key → unchanged (machine login)', async () => {
        const { svc, addDsh } = service(true);
        await addDsh('a');
        expect(svc.state().defaults.dsh).toBeUndefined();
        expect(svc.resolveSpawnAccount('dsh', undefined)).toBeNull();
    });

    it('no key and no account → machine login (dsh then says to add one)', () => {
        const { svc } = service(false);
        expect(svc.resolveSpawnAccount('dsh', undefined)).toBeNull();
    });

    it('an explicit account choice is used as is', async () => {
        const { svc, addDsh } = service(true);
        const a = await addDsh('a');
        expect(svc.resolveSpawnAccount('dsh', a.id)).toBe(a.id);
    });

    it('claude / codex never fall back', async () => {
        const { svc } = service(false);
        await svc.add({ agent: 'claude', kind: 'claude-api', label: 'c', baseUrl: 'https://example.com', key: { source: 'paste', value: FAKE_KEY } });
        expect(svc.resolveSpawnAccount('claude', undefined)).toBeNull();
    });

    it('an unusable account (key rejected) is not a fallback', async () => {
        const { home, svc, addDsh } = service(false, 'invalid');
        await addDsh('bad');
        const file = readAccountsFileV2(home);
        delete file.defaults.dsh;
        writeFileSync(join(home, 'accounts.json'), JSON.stringify({ version: 2, accounts: file.accounts, defaults: file.defaults }));
        expect(svc.resolveSpawnAccount('dsh', undefined)).toBeNull();
    });
});

describe('B-960 add: first DeepSeek account', () => {
    it('becomes the default when the machine login has no key; a second one does not', async () => {
        const { svc, addDsh } = service(false);
        const first = await addDsh('first');
        expect(svc.state().defaults.dsh).toBe(first.id);
        await addDsh('second');
        expect(svc.state().defaults.dsh).toBe(first.id);
    });

    it('stays unset when the machine login has a key', async () => {
        const { svc, addDsh } = service(true);
        await addDsh('first');
        expect(svc.state().defaults.dsh).toBeUndefined();
    });

    it('state reports only a boolean for the machine login', async () => {
        expect(service(false).svc.state().machineLoginKey).toEqual({ dsh: false });
        expect(service(true).svc.state().machineLoginKey).toEqual({ dsh: true });
    });
});

describe('B-960 pickMachineLoginFallback (shared with the Web)', () => {
    const acc = (id: string, status: string, createdAt: number, agent = 'dsh') => ({ id, agent, status, createdAt });
    it('ok before unverified, then the most recently added; unusable ones skipped', () => {
        expect(pickMachineLoginFallback([acc('old-ok', 'ok', 1), acc('new-unverified', 'unverified', 9)], 'dsh')).toBe('old-ok');
        expect(pickMachineLoginFallback([acc('a', 'ok', 1), acc('b', 'ok', 2)], 'dsh')).toBe('b');
        expect(pickMachineLoginFallback([acc('x', 'invalid', 3), acc('y', 'missing-secret', 4), acc('z', 'expired', 5)], 'dsh')).toBeNull();
        expect(pickMachineLoginFallback([acc('c', 'ok', 1, 'claude')], 'dsh')).toBeNull();
        expect(pickMachineLoginFallback([acc('c', 'ok', 1, 'claude')], 'claude')).toBeNull();
    });
    it('the state helper needs an explicit false and no default', () => {
        const accounts = [acc('a', 'ok', 1)];
        expect(machineLoginFallbackAccount({ accounts, defaults: {}, machineLoginKey: { dsh: false } }, 'dsh')).toBe('a');
        expect(machineLoginFallbackAccount({ accounts, defaults: {}, machineLoginKey: { dsh: true } }, 'dsh')).toBeNull();
        expect(machineLoginFallbackAccount({ accounts, defaults: {} }, 'dsh')).toBeNull();
        expect(machineLoginFallbackAccount({ accounts, defaults: { dsh: 'a' }, machineLoginKey: { dsh: false } }, 'dsh')).toBeNull();
    });
});

describe('B-960 dshMachineLoginHasKey', () => {
    const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
    it('env, dsh credentials file (both forms) and dsh .env count; empty values do not', () => {
        expect(dshMachineLoginHasKey({ DEEPSEEK_API_KEY: 'x', HOME: '/h' }, files({}))).toBe(true);
        expect(dshMachineLoginHasKey({ DEEPSEEK_API_KEY: '  ', HOME: '/h' }, files({}))).toBe(false);
        expect(dshMachineLoginHasKey({ HOME: '/h' }, files({ '/h/.dsh/.credentials.yaml': 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: abc\n' }))).toBe(true);
        expect(dshMachineLoginHasKey({ HOME: '/h' }, files({ '/h/.dsh/.credentials.yaml': 'DEEPSEEK_API_KEY: abc\n' }))).toBe(true);
        expect(dshMachineLoginHasKey({ HOME: '/h' }, files({ '/h/.dsh/.credentials.yaml': 'version: 1\nrefs: {}\n' }))).toBe(false);
        expect(dshMachineLoginHasKey({ HOME: '/h', DSH_HOME: '/d' }, files({ '/d/.env': 'DEEPSEEK_API_KEY=abc\n' }))).toBe(true);
        expect(dshMachineLoginHasKey({ HOME: '/h' }, files({ '/h/.dsh/.env': 'DEEPSEEK_API_KEY=\n' }))).toBe(false);
        expect(dshMachineLoginHasKey({ HOME: '/h' }, files({}))).toBe(false);
    });
    it('reads a real dsh home without returning the value', () => {
        const dir = mkdtempSync(join(tmpdir(), 'vh-b960-dsh-'));
        mkdirSync(join(dir, '.dsh'));
        writeFileSync(join(dir, '.dsh', '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${FAKE_KEY}\n`);
        expect(dshMachineLoginHasKey({ HOME: dir })).toBe(true);
    });
});

describe('B-960 the missing-key hint', () => {
    const raw = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY …';
    it('names the account when there is one; says to add one only when there is none', () => {
        expect(dshFailureHint(raw, { accountLabel: 'dsh coding' })).toBe(dshMissingKeyHint('dsh coding'));
        expect(dshMissingKeyHint('dsh coding')).toContain('"dsh coding"');
        expect(dshMissingKeyHint('dsh coding')).not.toContain('Add a DeepSeek account');
        expect(dshFailureHint(raw)).toBe(DSH_NO_KEY_ADD_ACCOUNT);
        expect(dshFailureHint(raw, { accountLabel: null })).toBe(DSH_NO_KEY_ADD_ACCOUNT);
    });
    it('dshHintContext: a machine-login session gets the usable account; an account session nothing', async () => {
        const { home, addDsh } = service(false);
        await addDsh('dsh coding');
        expect(dshHintContext(home, { profile: null }, {})).toEqual({ accountLabel: 'dsh coding' });
        expect(dshHintContext(home, { profile: { id: 'x', label: 'x', kind: 'dsh-api', status: 'active' } }, {})).toEqual({});
        expect(dshHintContext(mkdtempSync(join(tmpdir(), 'vh-b960-empty-')), { profile: null }, {})).toEqual({ accountLabel: null });
    });
});
