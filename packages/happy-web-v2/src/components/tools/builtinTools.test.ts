import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import {
    BUILTIN_TOOL_NAMES, builtinResultText, builtinToolDigest, builtinToolFields, builtinToolSummary,
    describeAutomationAction, describeAutomationTrigger, resolveBuiltinTool,
} from './builtinTools';

vi.mock('@/text', async () => await import('@/testing/englishText'));

const call = (name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({
    name, input, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, description: null, ...extra,
});
const mcpText = (value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

describe('resolveBuiltinTool — one identity for every runner name shape', () => {
    it('recognises the bare, Claude-prefixed and Gemini-prefixed names', () => {
        expect(resolveBuiltinTool(call('team_delegate', { goal: 'g' }))).toMatchObject({ name: 'team_delegate', via: 'bare', input: { goal: 'g' } });
        expect(resolveBuiltinTool(call('mcp__happy__team_delegate', { goal: 'g' }))).toMatchObject({ name: 'team_delegate', via: 'mcp', server: 'happy' });
        expect(resolveBuiltinTool(call('mcp__very-happy-clipboard__copy_to_clipboard', { text: 'x' }))).toMatchObject({ name: 'copy_to_clipboard', server: 'very-happy-clipboard' });
        expect(resolveBuiltinTool(call('happy__change_title', { title: 'T' }))).toMatchObject({ name: 'change_title', via: 'mcp', server: 'happy' });
    });

    it('unwraps the Codex McpTool envelope and the pi piTool/rawInput envelope', () => {
        expect(resolveBuiltinTool(call('McpTool', { server: 'happy', tool: 'automation_create', arguments: { name: 'a' } })))
            .toMatchObject({ name: 'automation_create', via: 'codex', server: 'happy', input: { name: 'a' } });
        expect(resolveBuiltinTool(call('other', { piTool: 'session_send', rawInput: { sessionId: 's1', text: 'hi' } })))
            .toMatchObject({ name: 'session_send', via: 'pi', input: { sessionId: 's1', text: 'hi' } });
    });

    it('leaves foreign servers, unknown tools and malformed input alone', () => {
        expect(resolveBuiltinTool(call('mcp__todo__todo_list', {}))).toBeNull();
        expect(resolveBuiltinTool(call('mcp__other__session_send', { sessionId: 'x' }))).toBeNull();
        expect(resolveBuiltinTool(call('McpTool', { server: 'jira', tool: 'team_create', arguments: {} }))).toBeNull();
        expect(resolveBuiltinTool(call('Bash', { command: 'ls' }))).toBeNull();
        expect(resolveBuiltinTool(call('team_delegate', 'not-an-object'))).toMatchObject({ name: 'team_delegate', input: {} });
        expect(resolveBuiltinTool(call('team_delegate', null))).toMatchObject({ input: {} });
        expect(resolveBuiltinTool({ name: undefined as unknown as string, input: {} })).toBeNull();
    });

    it('covers every tool the CLI injects', () => {
        // Mirrors startHappyServer.toolNames + assistantTools (Claude), the Codex bridge and `very-happy mcp`.
        const expected = [
            'change_title', 'copy_to_clipboard', 'open_preview', 'report_progress',
            'team_create', 'team_join', 'team_inspect', 'team_delegate', 'team_message', 'team_submit', 'team_accept', 'team_return', 'team_cancel', 'team_handoff',
            'team_schedule_create', 'team_schedule_pause', 'team_schedule_resume', 'team_schedule_cancel',
            'automation_list', 'automation_get', 'automation_create', 'automation_update', 'automation_pause', 'automation_resume', 'automation_delete',
            'automation_run', 'automation_fire', 'automation_runs', 'automation_report', 'automation_ack',
            'sessions_list', 'session_read', 'session_send', 'session_spawn', 'session_kill', 'session_archive',
            'terminals_list', 'terminal_read', 'terminal_send', 'memory_update', 'journal_append',
        ];
        expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...expected].sort());
    });
});

describe('builtinToolSummary — verb + human detail', () => {
    const summary = (name: string, input: unknown) => builtinToolSummary(resolveBuiltinTool(call(name, input))!);

    it('delegation names the target and the goal', () => {
        expect(summary('mcp__happy__team_delegate', { goal: 'Ship the automations page', acceptance: ['a'], assistant: 'codex' }))
            .toEqual({ label: 'Delegate task', detail: 'to Codex · Ship the automations page' });
        expect(summary('team_delegate', { goal: 'x', botName: 'reviewer' }).detail).toBe('to reviewer · x');
        expect(summary('team_delegate', {}).detail).toBeNull();
    });

    it('automation_create reads the trigger and action in words', () => {
        const detail = summary('automation_create', {
            name: 'daily-inventory',
            trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' },
            action: { kind: 'spawn', agent: 'claude', directory: '/home/me/code/app', prompt: 'p' },
        }).detail;
        // Trigger / action wording is B-498's (automationPresentation), reused rather than duplicated.
        expect(detail).toBe('daily-inventory · Daily at 09:00 · Asia/Singapore · claude · /home/me/code/app');
    });

    it('automation_update lists what changes', () => {
        expect(summary('automation_update', { name: 'nightly', version: 3, trigger: { kind: 'interval', everyMs: 7_200_000 }, concurrency: 'queue' }).detail)
            .toBe('nightly · Trigger, Concurrency · Every 2h');
    });

    it('title, clipboard, preview and progress are one-liners', () => {
        expect(summary('change_title', { title: 'Fix login' })).toEqual({ label: 'Title changed', detail: 'Fix login' });
        expect(summary('copy_to_clipboard', { text: 'short' }).detail).toBe('short');
        expect(summary('copy_to_clipboard', { text: 'x'.repeat(2500) }).detail).toBe(`${'x'.repeat(71)}… · 2.5k chars`);
        expect(summary('open_preview', { path: '/tmp/report.md' }).detail).toBe('/tmp/report.md');
        expect(summary('report_progress', { progress: 'tests green, awaiting review', attention: 'review' }).detail).toBe('needs review · tests green, awaiting review');
        expect(summary('report_progress', { progress: 'working', attention: 'none' }).detail).toBe('working');
    });

    it('session and terminal tools shorten ids and keep the message', () => {
        expect(summary('session_send', { sessionId: 'abcdefghijklmnopqrstuvwxyz', text: 'please\nrun tests' }).detail).toBe('abcdefgh… · please run tests');
        expect(summary('session_spawn', { directory: '/Users/me/code/very-happy', prompt: 'do it' }).detail).toBe('very-happy · do it');
        expect(summary('sessions_list', {}).detail).toBeNull();
        expect(summary('terminal_send', { terminalId: 't-1', text: 'ls', submit: true }).detail).toBe('t-1 · ls · Press Enter');
        expect(summary('memory_update', { section: 'Preferences' }).detail).toBe('Preferences');
    });

    it('automation run/report/runs read as status lines', () => {
        expect(summary('automation_report', { status: 'failed', error: 'boom', needsAttention: true }).detail).toBe('failed · needs review · boom');
        expect(summary('automation_runs', { name: 'nightly', attention: true }).detail).toBe('nightly · flagged only');
        expect(summary('automation_fire', { name: 'deploy', dedupeKey: 'build-42' }).detail).toBe('deploy · #build-42');
    });

    it('never throws on partial streaming input', () => {
        for (const name of BUILTIN_TOOL_NAMES) {
            for (const input of [undefined, null, {}, { goal: 1, name: [], trigger: 'x', action: 5, acceptance: 'no' }]) {
                const resolved = resolveBuiltinTool(call(name, input))!;
                expect(() => builtinToolSummary(resolved)).not.toThrow();
                expect(() => builtinToolFields(resolved)).not.toThrow();
                expect(() => builtinToolDigest(resolved, { state: 'running', result: undefined })).not.toThrow();
                expect(builtinToolSummary(resolved).label).not.toMatch(/^tools\./);
            }
        }
    });
});

describe('describeAutomationTrigger / Action — thin wrappers over B-498 automationPresentation', () => {
    it('validates against the wire schema, then delegates the wording', () => {
        expect(describeAutomationTrigger({ kind: 'cron', expr: '30 18 * * 1-5', tz: 'Europe/Berlin' })).toBe('18:30 on weekdays · Europe/Berlin');
        expect(describeAutomationTrigger({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' })).toBe('Every 5 minutes · UTC');
        expect(describeAutomationTrigger({ kind: 'interval', everyMs: 90_000 })).toBe('Every 2m');
        expect(describeAutomationTrigger({ kind: 'manual' })).toBe('Trigger only');
        expect(describeAutomationTrigger({ kind: 'once', at: Date.UTC(2026, 8, 25, 1, 0) })).toMatch(/^Once · .*2026/);
        // partial / malformed streaming input → null, the caller shows the raw shape
        expect(describeAutomationTrigger({ kind: 'cron', expr: '0 9 * * *' })).toBeNull();
        expect(describeAutomationTrigger({ kind: 'nope' })).toBeNull();
        expect(describeAutomationTrigger('garbage')).toBeNull();
        expect(describeAutomationAction({ kind: 'send', sessionId: 'abcdefghijklmnopq', prompt: 'p' })).toBe('Send to session abcdefghijklmnopq');
        expect(describeAutomationAction({ kind: 'script', command: ['node', 'scripts/x.mjs', '--all'], cwd: '/srv' })).toBe('cwd /srv');
        expect(describeAutomationAction({ kind: 'spawn' })).toBeNull();
    });
});

describe('builtinToolFields', () => {
    it('lists delegation fields with the acceptance criteria as items', () => {
        const fields = builtinToolFields(resolveBuiltinTool(call('team_delegate', {
            goal: 'Ship it', acceptance: ['tests green', 'docs updated'], assistant: 'pi-acp', directory: '/w', parentTaskId: 'parent-1',
        }))!);
        expect(fields.map((f) => [f.key, f.value])).toEqual([
            ['goal', 'Ship it'], ['acceptance', '2'], ['agent', 'pi'], ['directory', '/w'], ['parentTask', 'parent-1'],
        ]);
        expect(fields.find((f) => f.key === 'acceptance')?.items).toEqual(['tests green', 'docs updated']);
        expect(fields.find((f) => f.key === 'directory')?.mono).toBe(true);
    });

    it('expands the automation action into prompt / command lines', () => {
        const script = builtinToolFields(resolveBuiltinTool(call('automation_create', {
            name: 'backup', trigger: { kind: 'interval', everyMs: 3_600_000 }, action: { kind: 'script', command: ['rsync', '-a', 'src', 'dst'], cwd: '/srv' }, maxRuntimeMs: 600_000, paused: true,
        }))!);
        expect(script.map((f) => f.key)).toEqual(['name', 'trigger', 'action', 'command', 'directory', 'maxRuntime', 'status']);
        expect(script.find((f) => f.key === 'command')?.value).toBe('rsync -a src dst');
        expect(script.find((f) => f.key === 'status')?.value).toBe('paused');
        expect(builtinToolFields(resolveBuiltinTool(call('automation_create', {}))!)).toEqual([]);
    });
});

describe('builtinToolDigest — result lines, links and errors', () => {
    it('links a delegated task into the team page', () => {
        const digest = builtinToolDigest(resolveBuiltinTool(call('mcp__happy__team_delegate', { goal: 'g' }))!, {
            state: 'completed',
            result: mcpText({ taskId: 'task-9', team: { id: 'team-1', name: 'core', bots: [], tasks: [{ id: 'task-9', status: 'queued' }] } }),
        });
        expect(digest.lines).toEqual(['Task task-9 · queued']);
        expect(digest.links).toEqual([{ to: '/teams/team-1?task=task-9', label: 'Open task', id: 'task-9' }]);
    });

    it('summarises team create / inspect and links the team', () => {
        const created = builtinToolDigest(resolveBuiltinTool(call('team_create', { name: 'core' }))!, {
            state: 'completed', result: mcpText({ team: { id: 't/1', name: 'core', bots: [{}, {}] }, botId: 'b' }),
        });
        expect(created.lines).toEqual(['Team core · 2 members']);
        expect(created.links[0]).toEqual({ to: '/teams/t%2F1', label: 'Open team', id: 't/1' });
        const inspected = builtinToolDigest(resolveBuiltinTool(call('team_inspect', {}))!, {
            state: 'completed', result: mcpText({ team: { id: 't1', name: 'core', bots: [{}], tasks: [{}, {}], messages: [] } }),
        });
        expect(inspected.lines).toEqual(['core · 2 tasks · 1 members · 0 messages']);
    });

    it('digests automation objects, lists, runs and deletions', () => {
        const auto = { id: 'auto-1', name: 'daily', status: 'active', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, action: { kind: 'spawn', agent: 'codex', directory: '/a/b', prompt: 'p' }, nextRunAt: Date.UTC(2026, 8, 26, 9) };
        const created = builtinToolDigest(resolveBuiltinTool(call('automation_create', { name: 'daily' }))!, { state: 'completed', result: mcpText({ automation: auto }) });
        expect(created.lines[0]).toMatch(/^daily · Daily at 09:00 · UTC · next .*2026/);
        expect(created.lines[1]).toBe('codex · /a/b');
        expect(created.links).toEqual([{ to: '/automations/auto-1', label: 'Open automation', id: 'auto-1' }]); // B-498 detail route
        const list = builtinToolDigest(resolveBuiltinTool(call('automation_list', {}))!, { state: 'completed', result: mcpText({ automations: [auto, { ...auto, id: 'a2', name: 'paused-one', status: 'paused' }] }) });
        expect(list.lines[0]).toBe('2 automations');
        expect(list.lines[2]).toBe('paused-one · Daily at 09:00 · UTC · paused');
        const run = builtinToolDigest(resolveBuiltinTool(call('automation_run', { name: 'daily' }))!, { state: 'completed', result: mcpText({ run: { id: 'run-1234567890abc', status: 'queued', sessionId: 'sess-1', automationId: 'auto-1' } }) });
        expect(run.lines).toEqual(['queued · run-1234…']);
        expect(run.links).toEqual([{ to: '/automations/auto-1', label: 'Open automation', id: 'auto-1' }, { to: '/session/sess-1', label: 'Open session', id: 'sess-1' }]);
        // name-only reference without a result: no link to guess at
        expect(builtinToolDigest(resolveBuiltinTool(call('automation_pause', { name: 'daily' }))!, { state: 'running', result: undefined }).links).toEqual([]);
        const runs = builtinToolDigest(resolveBuiltinTool(call('automation_runs', {}))!, { state: 'completed', result: mcpText({ runs: [{ id: 'r1', status: 'failed', error: 'timeout', needsAttention: true }] }) });
        expect(runs.lines).toEqual(['1 run', 'failed · r1 · timeout · needs review']);
        const deleted = builtinToolDigest(resolveBuiltinTool(call('automation_delete', { name: 'daily' }))!, { state: 'completed', result: mcpText({ deleted: true, id: 'auto-1', name: 'daily' }) });
        expect(deleted.lines).toEqual(['Deleted daily']);
    });

    it('links spawned and addressed sessions from prose results', () => {
        const spawned = builtinToolDigest(resolveBuiltinTool(call('session_spawn', { directory: '/w' }))!, {
            state: 'completed', result: 'Spawned session abcdefgh1234 in /w and sent the first prompt. https://veryhappy.dev/session/abcdefgh1234',
        });
        expect(spawned.links).toEqual([{ to: '/session/abcdefgh1234', label: 'Open session', id: 'abcdefgh1234' }]);
        expect(spawned.json).toBeNull();
        expect(spawned.text).toContain('Spawned session');
        const sent = builtinToolDigest(resolveBuiltinTool(call('session_send', { sessionId: 'abcdefgh1234', text: 'x' }))!, { state: 'completed', result: mcpText('Message delivered') });
        expect(sent.links[0].to).toBe('/session/abcdefgh1234');
    });

    it('surfaces the error text and nothing else when the call failed', () => {
        const failed = builtinToolDigest(resolveBuiltinTool(call('automation_create', { name: 'x' }))!, {
            state: 'error', result: mcpText('automation name must match [a-z0-9][a-z0-9-_.]{0,63}'),
        });
        expect(failed.error).toBe('automation name must match [a-z0-9][a-z0-9-_.]{0,63}');
        expect(failed.lines).toEqual([]);
        expect(failed.links).toEqual([]);
        expect(builtinToolDigest(resolveBuiltinTool(call('team_inspect', {}))!, { state: 'error', result: { error: 'Join or create a team first' } }).error).toBe('Join or create a team first');
    });

    it('reads every MCP result shape', () => {
        expect(builtinResultText('plain')).toBe('plain');
        expect(builtinResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
        expect(builtinResultText({ content: [{ type: 'text', text: 'nested' }] })).toBe('nested');
        expect(builtinResultText({ output: 'o' })).toBe('o');
        expect(builtinResultText({ foo: 1 })).toBe('{\n  "foo": 1\n}');
        expect(builtinResultText(null)).toBe('');
    });
});
