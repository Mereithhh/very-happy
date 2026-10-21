import { describe, expect, it } from 'vitest';
import { LinkBudget, MAX_RECORD_CIPHER, OVERSIZE_TEXT, isSecretKey, makePathScrubber, projectLinkPage, projectRecordForLink, scrubLinkText } from './linkProjection';

const fake = (...parts: string[]) => parts.join('');

/**
 * B-701 security review: the link projection is a whitelist. Each case below
 * is a field the first (blacklist) version let through.
 */
const scrub = makePathScrubber({ cwd: '/home/alice/work/secret-project', homeDir: '/home/alice' });
const json = (v: unknown) => JSON.stringify(v);
// Built at runtime: a literal base64 blob trips the repository secret scanners.
const IMG = Buffer.from('fake-png-bytes-'.repeat(6)).toString('base64');

describe('B-701 link projection (whitelist)', () => {
    it('session tool-call-start: absolute paths become the project folder / ~', () => {
        const out = projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e1', time: 1, role: 'agent', turn: 't1', ev: { t: 'tool-call-start', call: 'c1', name: 'Read', title: 'Read file', description: 'd', args: { file_path: '/home/alice/work/secret-project/src/a.ts', other: '/home/alice/.ssh/id_rsa', foreign: '/Users/bob/x' } } } } }, scrub);
        const s = json(out);
        expect(s).not.toMatch(/\/home\/alice|\/Users\/bob/);
        expect(s).toContain('secret-project/src/a.ts');
        expect(s).toContain('~/.ssh/id_rsa');
        expect(s).toContain('~/x');
    });

    it('session turn-end: no cost, usage or duration; envelope usage dropped', () => {
        const out = projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e2', time: 1, role: 'agent', turn: 't1', usage: { input_tokens: 1, output_tokens: 2 }, claudeUuid: 'u', ev: { t: 'turn-end', status: 'completed', costUsd: 1.23, durationMs: 9, numTurns: 3, usage: { input_tokens: 1, output_tokens: 2 } } } } }, scrub);
        expect(out).toEqual({ role: 'session', content: { type: 'session', data: { id: 'e2', time: 1, role: 'agent', turn: 't1', ev: { t: 'turn-end', status: 'completed' } } } });
    });

    it('session thinking text and file events are not shown', () => {
        expect(projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'text', text: 'secret plan', thinking: true } } } }, scrub)).toBeNull();
        expect(projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'user', ev: { t: 'file', ref: 'r', name: 'a.png', size: 1 } } } }, scrub)).toBeNull();
    });

    it('legacy output records: only whitelisted fields (no cwd, gitBranch, toolUseResult, signature, usage)', () => {
        const out = projectRecordForLink({ role: 'agent', content: { type: 'output', data: {
            type: 'user', uuid: 'u2', parentUuid: 'u1', cwd: '/home/alice/work/secret-project', gitBranch: 'feature/acquisition', sessionId: 's', version: '2.0', userType: 'external',
            toolUseResult: { stdout: 'TOP SECRET', filePath: '/etc/passwd' },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }], permissions: { date: 1, result: 'approved', mode: 'bypassPermissions' } }] },
        } } }, scrub);
        const s = json(out);
        for (const leaked of ['cwd', 'gitBranch', 'acquisition', 'toolUseResult', 'TOP SECRET', 'permissions', 'bypassPermissions', IMG.slice(0, 20), 'sessionId', 'userType']) expect(s).not.toContain(leaked);
        expect(out).toEqual({ role: 'agent', content: { type: 'output', data: { type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } } } });
    });

    it('assistant blocks: thinking / image / unknown blocks dropped, model kept, usage dropped', () => {
        const out = projectRecordForLink({ role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'a', requestId: 'req_1', message: { role: 'assistant', model: 'claude', usage: { input_tokens: 5 }, content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'hi', citations: ['x'] }, { type: 'server_tool_use', id: 'z' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls /home/alice' } },
        ] } } } }, scrub);
        expect(out).toEqual({ role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'a', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls ~' } }] } } } });
    });

    it('free-form tool input/output: object-form images, base64 sources and data URIs are removed', () => {
        const out = projectRecordForLink({ role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'c', id: 'i', output: {
            screenshot: { type: 'image', data: IMG, mimeType: 'image/png' },
            nested: { source: { type: 'base64', data: IMG } },
            url: `data:image/png;base64,${IMG}`,
            text: 'done',
        } } } }, scrub);
        const s = json(out);
        expect(s).not.toContain(IMG.slice(0, 20));
        expect(s).toContain('done');
        expect(s).toContain('[image]');
    });

    it('result / system / reasoning / permission-request / ready-with-cost records are not shown', () => {
        expect(projectRecordForLink({ role: 'agent', content: { type: 'output', data: { type: 'result', total_cost_usd: 3, result: 'x' } } }, scrub)).toBeNull();
        expect(projectRecordForLink({ role: 'agent', content: { type: 'output', data: { type: 'system', cwd: '/home/alice' } } }, scrub)).toBeNull();
        expect(projectRecordForLink({ role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'r' } } }, scrub)).toBeNull();
        expect(projectRecordForLink({ role: 'agent', content: { type: 'acp', provider: 'gemini', data: { type: 'permission-request', permissionId: 'p', toolName: 't', description: 'd' } } }, scrub)).toBeNull();
        expect(projectRecordForLink({ role: 'agent', content: { type: 'event', id: 'e', data: { type: 'ready', turnMeta: { costUsd: 1 } } } }, scrub)).toBeNull();
    });

    it('user text and shared-message meta survive; other meta (mode, model, delivery) does not', () => {
        const out = projectRecordForLink({ role: 'user', content: { type: 'text', text: 'see /home/alice/work/secret-project/README.md' }, meta: { sentFrom: 'web', permissionMode: 'yolo', model: 'opus', delivery: 'steer', sharedBy: { accountId: 'acc_123', displayName: 'Bob' } } }, scrub);
        expect(out).toEqual({ role: 'user', content: { type: 'text', text: 'see secret-project/README.md' }, meta: { sentFrom: 'web', sharedBy: { accountId: 'shared', displayName: 'Bob' } } });
    });

    it('header text (title, project name) is path-scrubbed and secret-masked', () => {
        expect(scrubLinkText('Rotate key sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123 in /home/alice/x', scrub)).toBe('Rotate key [redacted] in ~/x');
        expect(scrubLinkText('API_KEY=abcdef123', scrub)).toBe('API_KEY=[redacted]');
    });

    it('free-form object KEYS are path-scrubbed and secret-masked too', () => {
        const token = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789';
        const out = projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'tool-call-start', call: 'c', name: 'Edit', title: 't', description: 'd', args: {
            [`/home/alice/work/secret-project/${token}`]: 1,
            ['OPENAI_API_KEY=' + 'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz']: 'x',
        } } } } }, scrub);
        const s = json(out);
        expect(s).not.toMatch(/\/home\/alice|abcdefghijklmnopqrstuvwxyz/);
        expect(s).toContain('secret-project/[redacted]');
        expect(s).toContain('OPENAI_API_KEY=[redacted]');
    });

    it('data URIs are removed anywhere in a string (markdown, HTML), not only at the start', () => {
        const out = projectRecordForLink({ role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'text', text: `Here: ![shot](data:image/png;base64,${IMG}) and <img src="data:image/jpeg;base64,${IMG}"> done` } } } }, scrub);
        const s = json(out);
        expect(s).not.toContain(IMG.slice(0, 16));
        expect(s).toContain('![shot]([image])');
        expect((out as any).content.data.ev.text).toContain('<img src="[image]">');
        expect(s).toContain('done');
    });

    // Re-review: a record is bounded as a whole, not just per string.
    it('a 1 MB adversarial record projects in < 200 ms', () => {
        const field = (i: number) => ['eyJ-', 'a-', 'TOKEN=', '"secret": "', 'a://b:', 'Bearer '][i % 6].repeat(32 * 1024 / 6);
        const args: Record<string, string> = {};
        for (let i = 0; i < 32; i++) args[`f${i}`] = field(i);
        const record = { role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'tool-call-start', call: 'c', name: 'n', title: 't', description: 'd', args } } } };
        expect(JSON.stringify(record).length).toBeGreaterThan(1_000_000);
        let out: unknown = null;
        let best = Infinity;
        for (let r = 0; r < 3; r++) {
            const t0 = performance.now();
            out = projectRecordForLink(record, scrub);
            best = Math.min(best, performance.now() - t0);
        }
        expect(best).toBeLessThan(200);
        expect(JSON.stringify(out).length).toBeLessThan(400 * 1024);
    });

    const env = (args: Record<string, unknown>) => ({ role: 'session', content: { type: 'session', data: { id: 'e', time: 1, role: 'agent', turn: 't', ev: { t: 'tool-call-start', call: 'c', name: 'n', title: 't', description: 'd', args } } } });

    // Re-review #3: the 256 KB record budget cut must not leak a straddling secret either.
    it('never exposes the head of a secret that straddles the record budget cut', () => {
        const secrets = [fake('"pass', 'word": "Hunter2Hunter2Zebra"'), fake('https://deploy:', 'SuperSecretPw123@db/x'), fake('Bear', 'er QwErTyUiOpAsDfGhJkLzXcVbNm123456'), fake('sk-', 'ant-api03-QwErTyUiOpAsDfGhJkLz0123'), fake('gh', 'p_QwErTyUiOpAsDfGhJkLzXcVbNm0123456789')];
        for (const secret of secrets) {
            const args: Record<string, string> = {};
            for (let i = 0; i < 8; i++) args[`f${i}`] = 'y '.repeat(15 * 1024); // 8 × 30 KB = 240 KB spent
            args.last = 'z '.repeat(Math.floor((16 * 1024 - 6) / 2)) + secret + ' tail'; // straddles the remaining 16 KB
            const s = json(projectRecordForLink(env(args), scrub));
            const value = secret.replace(/^.*?(Hunter2|SuperSecret|QwErTy|sk-ant|ghp_)/, '$1');
            for (let n = 4; n <= value.length; n++) expect(s, `leaks ${value.slice(0, n)}`).not.toContain(value.slice(0, n));
        }
    });

    const timed = (fn: () => unknown) => { fn(); let best = Infinity; let out: unknown; for (let r = 0; r < 5; r++) { const t0 = performance.now(); out = fn(); best = Math.min(best, performance.now() - t0); } return { best, out }; };

    // Re-review #4: empty strings and short keys are not free.
    it('a 1 MB record of empty strings projects in < 200 ms', () => {
        const record = env({ list: new Array(350_000).fill('') });
        expect(JSON.stringify(record).length).toBeGreaterThan(1_000_000);
        const { best, out } = timed(() => projectRecordForLink(record, scrub));
        expect(best).toBeLessThan(200);
        expect(json(out)).toContain('[truncated]');
    });

    // Most of this is V8 enumerating a 110k-key dictionary object (Object.keys alone
    // ≈ the same time); the review accepted ~220 ms per record given the page budget
    // (a page never decrypts more than 2 MB of ciphertext). Bound with headroom for CI.
    it('a 1 MB record of short keys projects in < 400 ms', () => {
        const args: Record<string, number> = {};
        for (let i = 0; i < 110_000; i++) args[`k${i}`] = 1;
        const record = env(args);
        expect(JSON.stringify(record).length).toBeGreaterThan(1_000_000);
        const { best } = timed(() => projectRecordForLink(record, scrub));
        expect(best).toBeLessThan(400);
    });

    it('a page of 200 such records is bounded as a whole and pages on', () => {
        const heavy = env({ list: new Array(250_000).fill(''), text: 'eyJ-'.repeat(64 * 1024) });
        const records = new Array(200).fill(heavy);
        const { best, out } = timed(() => projectLinkPage({ records, cipherLength: () => 0, decode: (r) => r, scrub }));
        expect(best).toBeLessThan(1000);
        const page = out as ReturnType<typeof projectLinkPage>;
        expect(page.consumed).toBeGreaterThan(0);
        expect(page.consumed).toBeLessThan(200);
    });

    // Re-review #5: an exhausted budget must not rename structural keys.
    it('structural keys survive an exhausted budget; rewritten free-form keys never collide', () => {
        const out = projectRecordForLink(env({ big: 'q '.repeat(200 * 1024), more: new Array(50).fill('w'.repeat(64)) }), scrub, new LinkBudget(scrub, 4096)) as any;
        expect(out.role).toBe('session');
        expect(out.content.type).toBe('session');
        expect(out.content.data.ev.t).toBe('tool-call-start');
        expect(Object.keys(out.content.data.ev).sort()).toEqual(['args', 'call', 'description', 'name', 't', 'title']);
        expect(Object.keys(out.content.data).sort()).toEqual(['ev', 'id', 'role', 'time', 'turn']);
        expect(out.content.data.ev.args.more[49]).toContain('[truncated]'); // values are cut once the budget is gone, keys are not
        const keys = projectRecordForLink(env({ '/home/alice/x': 1, '~/x': 2, '/Users/bob/x': 3 }), scrub) as any;
        expect(keys.content.data.ev.args).toEqual({ '~/x': 1, '~/x~2': 2, '~/x~3': 3 });
    });

    // Re-review 4 #1: records that project to NOTHING (reasoning) still pay for decrypt + parse.
    it('a page of 200 heavy reasoning records charges ciphertext up front and stops early', () => {
        let decoded = 0;
        const reasoning = { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'r'.repeat(600 * 1024) } } };
        const records = Array.from({ length: 200 }, (_, i) => ({ id: i, cipher: 900 * 1024 }));
        const t0 = performance.now();
        const page = projectLinkPage({ records, cipherLength: (r) => r.cipher, decode: () => { decoded++; return reasoning; }, scrub });
        expect(performance.now() - t0).toBeLessThan(1000);
        expect(page.projected).toHaveLength(0);
        expect(page.consumed).toBe(decoded);
        expect(decoded).toBeLessThanOrEqual(3); // 2 MB of ciphertext per page
        expect(decoded).toBeGreaterThanOrEqual(1);
    });

    // Re-review 4 #3: an oversize record is never decrypted or parsed.
    it('a record over the ciphertext gate is replaced by a placeholder without decoding', () => {
        let decoded = 0;
        const page = projectLinkPage({
            records: [{ id: 'big', cipher: MAX_RECORD_CIPHER + 1 }, { id: 'ok', cipher: 100 }],
            cipherLength: (r) => r.cipher,
            decode: () => { decoded++; return { role: 'user', content: { type: 'text', text: 'hi' } }; },
            oversize: (r) => ({ role: 'session', content: { type: 'session', data: { id: `oversize-${r.id}`, time: 1, role: 'agent', turn: 'x', ev: { t: 'service', text: OVERSIZE_TEXT } } } }),
            scrub,
        });
        expect(decoded).toBe(1);
        expect(page.consumed).toBe(2);
        expect(json(page.projected[0].content)).toContain(OVERSIZE_TEXT);
    });

    // Re-review 4 #2: a key that names a secret hides its value, whatever the value looks like.
    it('values under secret-named keys are redacted, nested too; ordinary keys are not', () => {
        for (const k of ['password', 'DB_PASSWORD', 'apiKey', 'x-api-key', 'Authorization', 'sessionToken', 'client_secret', 'AWS_SECRET_ACCESS_KEY', 'privateKey', 'cookie', 'DATABASE_URL']) expect(isSecretKey(k), k).toBe(true);
        for (const k of ['author', 'passage', 'tokenizer', 'command', 'file_path', 'description']) expect(isSecretKey(k), k).toBe(false);
        const out = projectRecordForLink(env({
            password: 'hunter2hunter2', apiKey: 12345678,
            env: { DB_PASSWORD: 'pw-0001', NODE_ENV: 'production', nested: [{ apiKey: 'k-abcdef' }, { Authorization: 'Basic dXNlcjpwYXNz' }] },
            headers: { Authorization: 'xyz' }, author: 'alice',
        }), scrub) as any;
        const args = out.content.data.ev.args;
        expect(args.password).toBe('[redacted]');
        expect(args.apiKey).toBe('[redacted]');
        expect(args.env.DB_PASSWORD).toBe('[redacted]');
        expect(args.env.NODE_ENV).toBe('production');
        expect(args.env.nested[0].apiKey).toBe('[redacted]');
        expect(args.env.nested[1].Authorization).toBe('[redacted]');
        expect(args.headers.Authorization).toBe('[redacted]');
        expect(args.author).toBe('alice');
        expect(json(out)).not.toMatch(/hunter2|pw-0001|k-abcdef|dXNlcjpwYXNz|12345678/);
        // .env text inside a string value is covered by the assignment scanner.
        const text = projectRecordForLink({ role: 'user', content: { type: 'text', text: 'DB_PASSWORD=pw-0001\nAPI_KEY=abc12345\nPORT=3005' } }, scrub) as any;
        expect(text.content.text).toBe('DB_PASSWORD=[redacted]\nAPI_KEY=[redacted]\nPORT=3005');
    });
});
