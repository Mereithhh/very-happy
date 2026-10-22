import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { AutomationReportSchema } from '@slopus/happy-wire';
import { actionFromCommand, AUTO_HELP, buildCliReport, describePrecheck, parseAutoArgs, precheckFromCommand } from './auto';

describe('very-happy auto argv parsing', () => {
    it('parses subcommands, targets, value/boolean flags, repeatable --env and script argv after --', () => {
        const command = parseAutoArgs(['create', '--name', 'nightly', '--cron', '0 9 * * *', '--tz=Asia/Singapore', '--script', '--env', 'A=1', '--env', 'B=2', '--paused', '--json', '--', 'python3', '-m', 'job', '--verbose']);
        expect(command.action).toBe('create');
        expect(command.flags['--name']).toBe('nightly');
        expect(command.flags['--tz']).toBe('Asia/Singapore');
        expect(command.env).toEqual(['A=1', 'B=2']);
        expect([...command.bools]).toEqual(['--script', '--paused', '--json']);
        expect(command.argv).toEqual(['python3', '-m', 'job', '--verbose']);
        expect(parseAutoArgs(['show', 'nightly']).target).toBe('nightly');
        expect(parseAutoArgs([]).action).toBe('help');
        expect(parseAutoArgs(['runs', '--help']).action).toBe('help');
    });
    it('B-508: ack --all needs no run id and may be limited to one automation', () => {
        const all = parseAutoArgs(['ack', '--all', '--name', 'daily', '--json']);
        expect(all.action).toBe('ack'); expect(all.bools.has('--all')).toBe(true); expect(all.flags['--name']).toBe('daily'); expect(all.target).toBeUndefined();
        expect(parseAutoArgs(['ack', 'r1']).target).toBe('r1');
        expect(AUTO_HELP).toContain('ack --all [--name <name>]');
    });
    it('treats --attention as a filter for runs and as a reason for report', () => {
        expect(parseAutoArgs(['runs', '--attention']).bools.has('--attention')).toBe(true);
        expect(parseAutoArgs(['report', '--run', 'r1', '--status', 'done', '--attention', 'needs review']).flags['--attention']).toBe('needs review');
    });
    it('rejects unknown commands, unknown or duplicate options and stray argv', () => {
        expect(() => parseAutoArgs(['frobnicate'])).toThrow('Unknown auto command');
        expect(() => parseAutoArgs(['list', '--bogus'])).toThrow('Unknown option');
        expect(() => parseAutoArgs(['create', '--name', 'a', '--name', 'b'])).toThrow('Duplicate');
        expect(() => parseAutoArgs(['show', 'a', 'b'])).toThrow('Unexpected argument');
        expect(() => parseAutoArgs(['create', '--name'])).toThrow('requires a value');
        expect(() => parseAutoArgs(['create', '--name', 'x', '--', 'echo'])).toThrow('--script');
    });
});

describe('action flags', () => {
    it('builds spawn / send / script actions with web-launcher defaults', () => {
        expect(actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'repo', '--prompt', 'go', '--sticky-key', '{{payload.id}}', '--worktree', '--model', 'm', '--permission-mode', 'plan'])))
            .toEqual({ kind: 'spawn', agent: 'claude', directory: resolve('repo'), prompt: 'go', model: 'm', permissionMode: 'plan', worktree: true, sticky: { key: '{{payload.id}}' } });
        expect(actionFromCommand(parseAutoArgs(['create', '--send-session', 's1', '--prompt', 'ping']))).toEqual({ kind: 'send', sessionId: 's1', prompt: 'ping' });
        expect(actionFromCommand(parseAutoArgs(['create', '--script', '--cwd', '/w', '--timeout', '5m', '--env', 'K=V', '--', 'echo', 'hi'])))
            .toEqual({ kind: 'script', command: ['echo', 'hi'], cwd: '/w', timeoutMs: 300_000, env: { K: 'V' } });
    });
    it('rejects mixed or incomplete actions and bad enum values', () => {
        expect(() => actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'x', '--send-session', 's', '--prompt', 'p']))).toThrow('only one');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'x']))).toThrow('--prompt');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--script']))).toThrow('after --');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--script', '--prompt', 'p', '--', 'x']))).toThrow('do not take --prompt');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--send-session', 's', '--prompt', 'p', '--agent', 'codex']))).toThrow('do not take --agent');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'x', '--prompt', 'p', '--agent', 'nope']))).toThrow('--agent must be one of');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'x', '--prompt', 'p', '--permission-mode', 'sudo']))).toThrow('--permission-mode must be one of');
        expect(() => actionFromCommand(parseAutoArgs(['create', '--spawn-dir', 'x', '--prompt', 'p', '--cwd', '/w']))).toThrow('do not take --cwd');
        expect(actionFromCommand(parseAutoArgs(['create']))).toBeUndefined();
        expect(() => actionFromCommand(parseAutoArgs(['create', '--prompt', 'p']))).toThrow('Give an action');
    });
    it('edits details of the existing action without restating its kind', () => {
        const spawn = { kind: 'spawn' as const, agent: 'codex', directory: '/r', prompt: 'old', model: 'm1' };
        expect(actionFromCommand(parseAutoArgs(['edit', 'n', '--prompt', 'new', '--model', 'm2']), spawn)).toEqual({ ...spawn, prompt: 'new', model: 'm2' });
        expect(actionFromCommand(parseAutoArgs(['edit', 'n']), spawn)).toBeUndefined();
        const script = { kind: 'script' as const, command: ['a'] };
        expect(actionFromCommand(parseAutoArgs(['edit', 'n', '--timeout', '1m']), script)).toEqual({ ...script, timeoutMs: 60_000 });
        expect(() => actionFromCommand(parseAutoArgs(['edit', 'n', '--prompt', 'x']), script)).toThrow('script actions do not take --prompt');
        expect(() => actionFromCommand(parseAutoArgs(['edit', 'n', '--cwd', '/x']), spawn)).toThrow('spawn actions do not take --cwd');
        expect(actionFromCommand(parseAutoArgs(['edit', 'n', '--script', '--', 'b']), spawn)).toEqual({ kind: 'script', command: ['b'] });
    });
    it('documents every subcommand in --help', () => {
        for (const word of ['list', 'show', 'create', 'edit', 'pause|resume|rm', 'fire', 'runs', 'cancel', 'ack', 'report', 'skill', 'install', '--sticky-key', '--dedupe-key', '--wait', 'VH_AUTOMATION_RUN_ID']) expect(AUTO_HELP).toContain(word);
    });
});

describe('B-548 precheck flags', () => {
    const pc = (args: string[], current?: Parameters<typeof precheckFromCommand>[1]) => precheckFromCommand(parseAutoArgs(['edit', 'n', ...args]), current);
    it('builds a shell or argv precheck with cwd, timeout and output', () => {
        expect(pc([])).toBeUndefined();
        expect(pc(['--precheck-shell', 'test -s inbox.json', '--precheck-timeout', '90s', '--precheck-output', '--precheck-cwd', '/w']))
            .toEqual({ shell: 'test -s inbox.json', cwd: '/w', timeoutMs: 90_000, includeOutput: true });
        expect(pc(['--precheck-argv', '["./has-new","--since","5m"]'])).toEqual({ command: ['./has-new', '--since', '5m'] });
        expect(pc(['--no-precheck'])).toBeNull();
    });
    it('adjusts the current precheck on edit and rejects ambiguous or invalid input', () => {
        expect(pc(['--precheck-timeout', '2m'], { shell: 'x', includeOutput: true })).toEqual({ shell: 'x', includeOutput: true, timeoutMs: 120_000 });
        expect(() => pc(['--precheck-timeout', '2m'])).toThrow('need a precheck');
        expect(() => pc(['--precheck-shell', 'x', '--precheck-argv', '["y"]'])).toThrow('only one');
        expect(() => pc(['--no-precheck', '--precheck-shell', 'x'])).toThrow('cannot be combined');
        expect(() => pc(['--precheck-argv', 'not json'])).toThrow('JSON array');
        expect(() => pc(['--precheck-argv', '[]'])).toThrow('non-empty');
        expect(() => pc(['--precheck-shell', 'x', '--precheck-timeout', '11m'])).toThrow('between 1s and 10m');
        expect(() => pc(['--precheck-shell', '   '])).toThrow('Invalid precheck');
    });
    it('documents and describes the precheck', () => {
        for (const word of ['--precheck-shell', '--precheck-argv', '--precheck-output', '--no-precheck', 'VH_AUTOMATION_PAYLOAD', '×N']) expect(AUTO_HELP).toContain(word);
        expect(describePrecheck({ shell: 'test -s x', timeoutMs: 5000, includeOutput: true })).toBe('sh: test -s x  (timeout 5s, output → prompt)');
    });

    it('B-767: report clips over-long --attention / --summary / --error and names each clipped flag', () => {
        const attention = '😀'.repeat(450); // 900 UTF-16 units; unit 512 would be the low half of an emoji
        const command = parseAutoArgs(['report', '--status', 'failed', '--attention', attention, '--summary', '总结'.repeat(2500), '--error', '😀'.repeat(2500), '--json']);
        const { report, notices } = buildCliReport('failed', command.flags);
        expect(AutomationReportSchema.safeParse(report).success).toBe(true);
        expect(report.needsAttention).toBe(true);
        expect(report.attentionReason).toBe(`${'😀'.repeat(255)}…`); // 510 units + `…`: never half an emoji
        expect(report.summary).toHaveLength(4096);
        expect(report.error).toHaveLength(4095);
        expect(notices).toEqual([
            '--summary clipped 5000→4096 chars (server limit 4096).',
            '--error clipped 5000→4095 chars (server limit 4096).',
            '--attention clipped 900→511 chars (server limit 512).',
        ]);
        expect(buildCliReport('done', parseAutoArgs(['report', '--status', 'done', '--summary', 'ok']).flags)).toEqual({ report: { status: 'done', summary: 'ok' }, notices: [] });
    });
});
