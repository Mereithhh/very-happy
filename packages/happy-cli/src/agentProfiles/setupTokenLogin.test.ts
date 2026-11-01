import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LOGIN_CODE_TIMEOUT_MS,
    SetupTokenLoginManager,
    findAuthorizeUrl,
    findLoginError,
    findSetupToken,
    setupTokenEnv,
    stripAnsi,
    type PtyLike,
} from './setupTokenLogin';

// Fake credentials, assembled at runtime so secret scanners do not flag test literals.
const OAT = ['sk', 'ant', 'oat01', ''].join('-');

const URL_LINE = '\x1b[2m Browser didn\'t open?\x1b[0m\r\n https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&scope=user%3Ainference&state=abc \r\n Paste code here if prompted >';
const TOKEN = OAT + '' + 'A'.repeat(90) + '-xyzAA';

class FakePty implements PtyLike {
    written: string[] = [];
    killed = false;
    private data: Array<(d: string) => void> = [];
    private exit: Array<(e: { exitCode: number }) => void> = [];
    onData(cb: (d: string) => void) { this.data.push(cb); }
    onExit(cb: (e: { exitCode: number }) => void) { this.exit.push(cb); }
    write(d: string) { this.written.push(d); }
    kill() { this.killed = true; }
    emit(d: string) { for (const cb of this.data) cb(d); }
    die(code = 0) { for (const cb of this.exit) cb({ exitCode: code }); }
}

function setup(onToken = vi.fn(async () => ({ id: 'org-a', label: 'Org A', agent: 'claude', kind: 'claude-subscription', status: 'ok' }))) {
    const pty = new FakePty();
    const spawnEnvs: Record<string, string>[] = [];
    let n = 0;
    const manager = new SetupTokenLoginManager({
        spawnPty: (env) => { spawnEnvs.push(env); return pty; },
        env: { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'leak', CLAUDE_CODE_OAUTH_TOKEN: 'machine' },
        onToken,
        newId: () => `login-${++n}`,
        now: () => 1_000,
    });
    return { pty, manager, onToken, spawnEnvs };
}

describe('B-850a setup-token remote login', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('parsers: URL across ANSI, token, Ink error line', () => {
        expect(findAuthorizeUrl(stripAnsi(URL_LINE))).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&scope=user%3Ainference&state=abc');
        expect(findSetupToken(stripAnsi(`\x1b[32m${TOKEN}\x1b[0m\r\n`))).toBe(TOKEN);
        expect(findSetupToken(OAT + 'short')).toBeNull();
        expect(findLoginError(stripAnsi('[>0q ****#state\n   OAuth error: Request failed with status code 400       Press  Enter  to retry.'))).toBe('OAuth error: Request failed with status code 400');
    });

    it('pty env: no inherited credential, no browser on the daemon host', () => {
        const env = setupTokenEnv({ PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', ANTHROPIC_BASE_URL: 'z' });
        expect(env).toEqual({ PATH: '/bin', BROWSER: 'true', TERM: 'xterm-256color' });
    });

    it('start → URL → submit code → token stored → succeeded; the token is never in a status', async () => {
        const { pty, manager, onToken, spawnEnvs } = setup();
        const started = manager.start();
        pty.emit(URL_LINE);
        const status = await started;
        expect(status).toMatchObject({ loginId: 'login-1', state: 'waiting-code', expiresAt: 1_000 + LOGIN_CODE_TIMEOUT_MS });
        expect(status.url).toContain('/oauth/authorize?');
        expect(spawnEnvs[0].ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(manager.submit('login-1', '  abc#state \n').state).toBe('exchanging');
        expect(pty.written).toEqual(['abc#state\r']);
        pty.emit(`Your OAuth token (valid for 1 year):\r\n${TOKEN}\r\n`);
        pty.die(0); // setup-token exits right after printing: not a failure
        await vi.waitFor(() => expect(manager.status('login-1').state).toBe('succeeded'));
        expect(onToken).toHaveBeenCalledWith('login-1', TOKEN);
        const final = manager.status('login-1');
        expect(JSON.stringify(final)).not.toContain('sk-ant-oat01');
        expect(final.account?.id).toBe('org-a');
        expect(final.url).toBeUndefined();
    });

    it('a rejected code fails the login with Claude\'s reason and kills the pty', async () => {
        const { pty, manager } = setup();
        const started = manager.start();
        pty.emit(URL_LINE);
        await started;
        manager.submit('login-1', 'bad');
        pty.emit('\x1b[31m OAuth error: Request failed with status code 400 \x1b[0m      Press Enter to retry.');
        expect(manager.status('login-1')).toMatchObject({ state: 'failed', error: 'OAuth error: Request failed with status code 400' });
        expect(pty.killed).toBe(true);
        expect(manager.activeLoginId()).toBeNull();
    });

    it('one login at a time; cancel and code timeout are terminal', async () => {
        const { pty, manager } = setup();
        const started = manager.start();
        pty.emit(URL_LINE);
        await started;
        await expect(manager.start()).rejects.toMatchObject({ code: 'login-busy' });
        vi.advanceTimersByTime(LOGIN_CODE_TIMEOUT_MS + 1);
        expect(manager.status('login-1').state).toBe('expired');
        expect(pty.killed).toBe(true);
        expect(manager.submit('login-1', 'late').state).toBe('expired');
        expect(() => manager.status('nope')).toThrow(/unknown/);
    });

    it('no URL within the budget → failed; process exit before a code → failed', async () => {
        const a = setup();
        const started = a.manager.start();
        vi.advanceTimersByTime(25_000);
        expect((await started).state).toBe('failed');
        const b = setup();
        const s2 = b.manager.start();
        b.pty.emit(URL_LINE);
        await s2;
        b.pty.die(1);
        expect(b.manager.status('login-1')).toMatchObject({ state: 'failed', error: 'claude setup-token exited (1)' });
        const c = setup();
        const s3 = c.manager.start();
        c.pty.emit(URL_LINE);
        await s3;
        expect(c.manager.cancel('login-1').state).toBe('canceled');
        expect(c.pty.killed).toBe(true);
    });
});
