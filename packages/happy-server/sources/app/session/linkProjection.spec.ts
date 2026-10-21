import { describe, expect, it } from 'vitest';
import { makePathScrubber, projectRecordForLink, scrubLinkText } from './linkProjection';

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
});
