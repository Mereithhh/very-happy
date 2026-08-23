import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    WEBHOOK_TOKEN_PREFIX,
    buildManualWebhookPayload,
    buildWebhookPayload,
    buildWebhookToken,
    createAccountRateLimiter,
    isPublicWebhookAddress,
    mapKindToWebhookEvent,
    parseWebhookToken,
    resolveWebhookTarget,
    sendWebhookWithDependencies,
    validateWebhookUrl,
} from './webhookNotify';

describe('validateWebhookUrl', () => {
    it('accepts a normal public https URL', () => {
        expect(validateWebhookUrl('https://ntfy.example.com/api/ingest/abc123')).toBeNull();
        expect(validateWebhookUrl('https://hooks.example.org:8443/path?x=1')).toBeNull();
    });

    it('rejects empty / non-string / oversized input', () => {
        expect(validateWebhookUrl('')).not.toBeNull();
        expect(validateWebhookUrl('   ')).not.toBeNull();
        expect(validateWebhookUrl(undefined)).not.toBeNull();
        expect(validateWebhookUrl(42 as unknown as string)).not.toBeNull();
        expect(validateWebhookUrl('https://example.com/' + 'a'.repeat(3000))).not.toBeNull();
    });

    it('rejects non-https schemes', () => {
        expect(validateWebhookUrl('http://example.com/hook')).not.toBeNull();
        expect(validateWebhookUrl('ftp://example.com/hook')).not.toBeNull();
        expect(validateWebhookUrl('file:///etc/passwd')).not.toBeNull();
        expect(validateWebhookUrl('not a url')).not.toBeNull();
    });

    it('rejects credentials embedded in the URL', () => {
        expect(validateWebhookUrl('https://user:pass@example.com/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://user@example.com/hook')).not.toBeNull();
    });

    it('rejects loopback and localhost variants', () => {
        expect(validateWebhookUrl('https://localhost/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://LOCALHOST:8443/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://foo.localhost/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://127.0.0.1/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://127.8.9.10/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://[::1]/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://[::]/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://0.0.0.0/hook')).not.toBeNull();
    });

    it('rejects private / link-local / CGNAT ranges', () => {
        expect(validateWebhookUrl('https://10.0.0.1/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://10.255.255.255/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://172.16.0.1/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://172.31.99.1/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://192.168.1.1/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://169.254.169.254/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://100.100.1.1/hook')).not.toBeNull(); // CGNAT / tailnet
        expect(validateWebhookUrl('https://[fd7a:115c::1]/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://[fe80::1]/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://[::ffff:192.168.1.1]/hook')).not.toBeNull();
    });

    it('allows public IPs adjacent to private ranges', () => {
        expect(validateWebhookUrl('https://172.15.0.1/hook')).toBeNull();
        expect(validateWebhookUrl('https://172.32.0.1/hook')).toBeNull();
        expect(validateWebhookUrl('https://11.0.0.1/hook')).toBeNull();
        expect(validateWebhookUrl('https://100.63.0.1/hook')).toBeNull();
        expect(validateWebhookUrl('https://100.128.0.1/hook')).toBeNull();
    });

    it('rejects bare-number / hex / octal IP encodings', () => {
        expect(validateWebhookUrl('https://2130706433/hook')).not.toBeNull();      // 127.0.0.1 decimal
        expect(validateWebhookUrl('https://0x7f000001/hook')).not.toBeNull();      // 127.0.0.1 hex
        expect(validateWebhookUrl('https://0177.0.0.1/hook')).not.toBeNull();      // octal-ish
        expect(validateWebhookUrl('https://127.1/hook')).not.toBeNull();           // shorthand
    });

    it('rejects .local / .internal suffixes and trailing-dot tricks', () => {
        expect(validateWebhookUrl('https://printer.local/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://db.internal/hook')).not.toBeNull();
        expect(validateWebhookUrl('https://localhost./hook')).not.toBeNull();
    });
});

describe('DNS-pinned webhook delivery', () => {
    const payload = { title: 'done', message: 'ok' };

    it('classifies public unicast and special-purpose addresses', () => {
        expect(isPublicWebhookAddress('8.8.8.8')).toBe(true);
        expect(isPublicWebhookAddress('2606:4700:4700::1111')).toBe(true);
        expect(isPublicWebhookAddress('10.0.0.1')).toBe(false);
        expect(isPublicWebhookAddress('169.254.169.254')).toBe(false);
        expect(isPublicWebhookAddress('192.0.2.10')).toBe(false);
        expect(isPublicWebhookAddress('224.0.0.1')).toBe(false);
        expect(isPublicWebhookAddress('2001:db8::1')).toBe(false);
        expect(isPublicWebhookAddress('fc00::1')).toBe(false);
        expect(isPublicWebhookAddress('::ffff:127.0.0.1')).toBe(false);
    });

    it('rejects a hostname whose DNS answer is private', async () => {
        const transport = vi.fn();
        const result = await sendWebhookWithDependencies('https://hooks.example.test/incoming', payload, {
            resolve: async () => [{ address: '10.20.30.40', family: 4 }],
            transport,
        });
        expect(result).toEqual({ ok: false, error: 'webhook host resolved to a non-public address' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects mixed public/private A and AAAA answers fail closed', async () => {
        const transport = vi.fn();
        const result = await sendWebhookWithDependencies('https://hooks.example.test/incoming', payload, {
            resolve: async () => [
                { address: '8.8.8.8', family: 4 },
                { address: 'fd00::1234', family: 6 },
            ],
            transport,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('non-public');
        expect(transport).not.toHaveBeenCalled();
    });

    it('pins the selected answer and never gives transport a chance to re-resolve', async () => {
        let resolveCount = 0;
        const transport = vi.fn(async target => ({
            ok: target.address === '8.8.4.4',
            status: 204,
        }));
        const result = await sendWebhookWithDependencies('https://hooks.example.test:8443/incoming', payload, {
            resolve: async () => {
                resolveCount += 1;
                return resolveCount === 1
                    ? [{ address: '8.8.4.4', family: 4 }]
                    : [{ address: '127.0.0.1', family: 4 }];
            },
            transport,
        });
        expect(result).toEqual({ ok: true, status: 204 });
        expect(resolveCount).toBe(1);
        expect(transport).toHaveBeenCalledWith(
            expect.objectContaining({
                address: '8.8.4.4',
                family: 4,
                hostname: 'hooks.example.test',
            }),
            JSON.stringify(payload),
        );
    });

    it('preserves the public TLS hostname/path and treats redirect as failure', async () => {
        const target = await resolveWebhookTarget(
            'https://hooks.example.test:9443/api/incoming?token=x',
            async () => [{ address: '1.1.1.1', family: 4 }],
        );
        expect(target.hostname).toBe('hooks.example.test');
        expect(target.url.host).toBe('hooks.example.test:9443');
        expect(target.url.pathname).toBe('/api/incoming');

        const result = await sendWebhookWithDependencies(target.url.href, payload, {
            resolve: async () => [{ address: '1.1.1.1', family: 4 }],
            // The transport contract reports the one response. There is no
            // redirect URL or resolver callback through which to follow it.
            transport: async () => ({ ok: false, status: 302 }),
        });
        expect(result).toEqual({ ok: false, status: 302 });
    });

    it('fails closed on empty or failed DNS resolution', async () => {
        await expect(resolveWebhookTarget('https://hooks.example.test/x', async () => []))
            .rejects.toThrow('did not resolve');
        const result = await sendWebhookWithDependencies('https://hooks.example.test/x', payload, {
            resolve: async () => { throw new Error('dns unavailable'); },
            transport: vi.fn(),
        });
        expect(result).toEqual({ ok: false, error: 'dns unavailable' });
    });
});

describe('webhook token round-trip', () => {
    it('serializes and parses back', () => {
        const token = buildWebhookToken({ url: 'https://ntfy.example.com/api/ingest/t0k', events: ['completed'] });
        expect(token.startsWith(WEBHOOK_TOKEN_PREFIX)).toBe(true);
        const parsed = parseWebhookToken(token);
        expect(parsed).toEqual({ url: 'https://ntfy.example.com/api/ingest/t0k', events: ['completed'] });
    });

    it('returns null for non-webhook / malformed / unsafe tokens', () => {
        expect(parseWebhookToken('ExponentPushToken[abc]')).toBeNull();
        expect(parseWebhookToken('webpush:{"endpoint":"x"}')).toBeNull();
        expect(parseWebhookToken('webhook:not-json')).toBeNull();
        expect(parseWebhookToken('webhook:{"events":[]}')).toBeNull();
        // URL smuggled past the config API must still fail closed.
        expect(parseWebhookToken('webhook:{"url":"http://127.0.0.1/x"}')).toBeNull();
        expect(parseWebhookToken('webhook:{"url":"https://10.0.0.1/x"}')).toBeNull();
    });

    it('defaults events to all and drops unknown event names', () => {
        expect(parseWebhookToken('webhook:{"url":"https://example.com/h"}')?.events)
            .toEqual(['completed', 'permission']);
        expect(parseWebhookToken('webhook:{"url":"https://example.com/h","events":["permission","bogus"]}')?.events)
            .toEqual(['permission']);
    });
});

describe('mapKindToWebhookEvent', () => {
    it('maps done to completed, permission/question to permission', () => {
        expect(mapKindToWebhookEvent('done')).toBe('completed');
        expect(mapKindToWebhookEvent('permission')).toBe('permission');
        expect(mapKindToWebhookEvent('question')).toBe('permission');
    });

    it('maps unknown kinds to null', () => {
        expect(mapKindToWebhookEvent('error')).toBeNull();
        expect(mapKindToWebhookEvent(undefined)).toBeNull();
        expect(mapKindToWebhookEvent(42)).toBeNull();
    });
});

describe('buildWebhookPayload', () => {
    it('builds a done payload from sessionTitle', () => {
        const p = buildWebhookPayload({
            body: 'my-project',
            data: { kind: 'done', sessionTitle: '重构推送模块', provider: 'claude' },
        });
        expect(p).not.toBeNull();
        expect(p!.title).toBe('✅ 任务完成 · 重构推送模块');
        expect(p!.message).toContain('任务已完成');
        expect(p!.message).toContain('会话：重构推送模块');
        expect(p!.message).toContain('Agent：claude');
        // Gateway renders title as the heading — message must not lead with it.
        expect(p!.message.startsWith(p!.title)).toBe(false);
        expect(p!.message.startsWith('#')).toBe(false);
    });

    it('builds a permission payload including the tool name', () => {
        const p = buildWebhookPayload({
            body: 'my-project',
            data: { kind: 'permission', sessionTitle: 'my-project', tool: 'Bash', provider: 'claude' },
        });
        expect(p!.title).toBe('⏸ 需要确认 · my-project');
        expect(p!.message).toContain('请求执行工具：Bash');
    });

    it('builds a question payload', () => {
        const p = buildWebhookPayload({
            body: 'my-project',
            data: { kind: 'question', sessionTitle: 'my-project' },
        });
        expect(p!.title).toBe('❓ 等待回答 · my-project');
        expect(p!.message).toContain('等待回答');
    });

    it('falls back to push body then to a generic title', () => {
        const fromBody = buildWebhookPayload({ body: 'fallback-title', data: { kind: 'done' } });
        expect(fromBody!.title).toBe('✅ 任务完成 · fallback-title');
        const generic = buildWebhookPayload({ body: '', data: { kind: 'done' } });
        expect(generic!.title).toBe('✅ 任务完成 · Session');
    });

    it('truncates a long session title in the heading', () => {
        const long = 'x'.repeat(300);
        const p = buildWebhookPayload({ body: '', data: { kind: 'done', sessionTitle: long } });
        expect(p!.title.length).toBeLessThan(80);
        expect(p!.title.endsWith('…')).toBe(true);
    });

    it('returns null for unmapped kinds', () => {
        expect(buildWebhookPayload({ body: 'x', data: { kind: 'error' } })).toBeNull();
        expect(buildWebhookPayload({ body: 'x', data: {} })).toBeNull();
    });
});

describe('buildWebhookPayload session link', () => {
    const originalWebUrl = process.env.HAPPY_WEB_URL;
    afterEach(() => {
        if (originalWebUrl === undefined) {
            delete process.env.HAPPY_WEB_URL;
        } else {
            process.env.HAPPY_WEB_URL = originalWebUrl;
        }
    });

    it('adds sessionId field and a parseable session trailer line', () => {
        delete process.env.HAPPY_WEB_URL;
        const p = buildWebhookPayload({
            body: 'my-project',
            data: { kind: 'done', sessionId: 'sess-abc-123', sessionTitle: 'my-project' },
        });
        expect(p!.sessionId).toBe('sess-abc-123');
        const lines = p!.message.split('\n');
        // The session trailer is the LAST line and its format is a contract
        // with external dispatchers — keep `session: <id>` exact.
        expect(lines[lines.length - 1]).toBe('session: sess-abc-123');
        // No HAPPY_WEB_URL → no link line.
        expect(p!.message).not.toContain('链接：');
    });

    it('adds a session URL line when HAPPY_WEB_URL is set (trailing slash trimmed)', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com/';
        const p = buildWebhookPayload({
            body: 'my-project',
            data: { kind: 'permission', sessionId: 'sess-abc-123', tool: 'Bash' },
        });
        expect(p!.message).toContain('链接：https://happy.example.com/session/sess-abc-123');
        const lines = p!.message.split('\n');
        expect(lines[lines.length - 1]).toBe('session: sess-abc-123');
    });

    it('omits sessionId field and trailer when data has no sessionId', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com';
        const p = buildWebhookPayload({ body: 'x', data: { kind: 'done' } });
        expect(p!.sessionId).toBeUndefined();
        expect(p!.message).not.toContain('session:');
        expect(p!.message).not.toContain('链接：');
    });
});

describe('buildManualWebhookPayload', () => {
    const originalWebUrl = process.env.HAPPY_WEB_URL;
    afterEach(() => {
        if (originalWebUrl === undefined) {
            delete process.env.HAPPY_WEB_URL;
        } else {
            process.env.HAPPY_WEB_URL = originalWebUrl;
        }
    });

    it('builds title/message with the session trailer as the LAST line', () => {
        delete process.env.HAPPY_WEB_URL;
        const p = buildManualWebhookPayload({
            title: '✅ 已完成 · fix tests',
            message: '已确认完成。',
            sessionId: 'sess-1',
        });
        expect(p.title).toBe('✅ 已完成 · fix tests');
        expect(p.sessionId).toBe('sess-1');
        const lines = p.message.split('\n');
        expect(lines[0]).toBe('已确认完成。');
        expect(lines[lines.length - 1]).toBe('session: sess-1');
        expect(p.message).not.toContain('链接：');
    });

    it('adds a link line when HAPPY_WEB_URL is set', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com/';
        const p = buildManualWebhookPayload({ title: 't', sessionId: 'sess-2' });
        expect(p.message).toContain('链接：https://happy.example.com/session/sess-2');
        const lines = p.message.split('\n');
        expect(lines[lines.length - 1]).toBe('session: sess-2');
    });

    it('puts the task line BEFORE the session trailer (session stays last)', () => {
        delete process.env.HAPPY_WEB_URL;
        const p = buildManualWebhookPayload({
            title: 't',
            taskId: 'task-9',
            sessionId: 'sess-3',
        });
        const lines = p.message.split('\n');
        expect(lines[lines.length - 2]).toBe('task: task-9');
        expect(lines[lines.length - 1]).toBe('session: sess-3');
    });

    it('task-only notification carries the task line and no session field', () => {
        const p = buildManualWebhookPayload({ title: 't', taskId: 'task-1' });
        expect(p.sessionId).toBeUndefined();
        expect(p.message).toBe('task: task-1');
    });

    it('trims and caps title/message, tolerates empty message', () => {
        const p = buildManualWebhookPayload({
            title: '  ' + 'x'.repeat(500),
            message: 'y'.repeat(2000),
        });
        expect(p.title.length).toBe(200);
        const lines = p.message.split('\n');
        expect(lines[0].length).toBe(1000);
        const empty = buildManualWebhookPayload({ title: 't' });
        expect(empty.message).toBe('');
    });

    it('appends a 链接 line for a web-app `link` path when HAPPY_WEB_URL is set', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com/';
        const p = buildManualWebhookPayload({
            title: '修 bug 的终端',
            message: 'Claude 等待下一步指令',
            link: '/terminal/m1?tid=abc123',
        });
        const lines = p.message.split('\n');
        expect(lines[0]).toBe('Claude 等待下一步指令');
        expect(lines[1]).toBe('链接：https://happy.example.com/terminal/m1?tid=abc123');
        expect(p.sessionId).toBeUndefined();
    });

    it('omits the link line when HAPPY_WEB_URL is unset (no half-built URL)', () => {
        delete process.env.HAPPY_WEB_URL;
        const p = buildManualWebhookPayload({
            title: 't',
            message: 'm',
            link: '/terminal/m1?tid=abc123',
        });
        expect(p.message).toBe('m');
    });

    it('ignores a non-path link (defense in depth behind the route schema)', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com';
        const p = buildManualWebhookPayload({
            title: 't',
            message: 'm',
            link: 'https://evil.example.com/phish',
        });
        expect(p.message).toBe('m');
    });

    it('keeps the session trailer LAST when both link and sessionId are present', () => {
        process.env.HAPPY_WEB_URL = 'https://happy.example.com';
        const p = buildManualWebhookPayload({
            title: 't',
            message: 'm',
            link: '/board',
            sessionId: 'sess-7',
        });
        const lines = p.message.split('\n');
        expect(lines[0]).toBe('m');
        expect(lines[1]).toBe('链接：https://happy.example.com/board');
        expect(lines[lines.length - 1]).toBe('session: sess-7');
    });
});

describe('createAccountRateLimiter', () => {
    it('allows up to max within the window, then rejects', () => {
        const limiter = createAccountRateLimiter({ max: 3, windowMs: 1000 });
        const t0 = 1_000_000;
        expect(limiter.allow('a', t0)).toBe(true);
        expect(limiter.allow('a', t0 + 1)).toBe(true);
        expect(limiter.allow('a', t0 + 2)).toBe(true);
        expect(limiter.allow('a', t0 + 3)).toBe(false);
    });

    it('window slides: old hits expire and free capacity', () => {
        const limiter = createAccountRateLimiter({ max: 2, windowMs: 1000 });
        const t0 = 1_000_000;
        expect(limiter.allow('a', t0)).toBe(true);
        expect(limiter.allow('a', t0 + 100)).toBe(true);
        expect(limiter.allow('a', t0 + 200)).toBe(false);
        // t0 hit expires at t0+1001
        expect(limiter.allow('a', t0 + 1001)).toBe(true);
    });

    it('accounts are isolated', () => {
        const limiter = createAccountRateLimiter({ max: 1, windowMs: 1000 });
        const t0 = 1_000_000;
        expect(limiter.allow('a', t0)).toBe(true);
        expect(limiter.allow('b', t0)).toBe(true);
        expect(limiter.allow('a', t0 + 1)).toBe(false);
    });
});
