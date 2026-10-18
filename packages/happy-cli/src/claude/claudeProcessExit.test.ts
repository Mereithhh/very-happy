import { describe, expect, it } from 'vitest';
import { CLAUDE_STDERR_TAIL_CHARS, describeClaudeProcessExit } from './claudeProcessExit';

describe('describeClaudeProcessExit (B-631)', () => {
    it('keeps the SDK exit code and the stderr tail on one line, ANSI stripped', () => {
        const error = new Error('Claude Code process exited with code 1. stderr: \x1b[31mError:\x1b[0m Not logged in.\n  Run `claude login`\n\n');
        expect(describeClaudeProcessExit(error))
            .toBe('Process exited unexpectedly (code 1): Error: Not logged in. Run `claude login`');
    });

    it('names the signal when the process was killed', () => {
        expect(describeClaudeProcessExit(new Error('Claude Code process terminated by signal SIGKILL')))
            .toBe('Process exited unexpectedly (signal SIGKILL)');
        expect(describeClaudeProcessExit(new Error('Claude Code process terminated by signal SIGSEGV. stderr: boom')))
            .toBe('Process exited unexpectedly (signal SIGSEGV): boom');
    });

    it('keeps the LAST 400 characters of a long stderr tail', () => {
        const tail = Array.from({ length: 120 }, (_, i) => `line${i}`).join(' ');
        const text = describeClaudeProcessExit(new Error(`Claude Code process exited with code 2. stderr: ${tail}`));
        const detail = text.slice('Process exited unexpectedly (code 2): '.length);
        expect(detail).toHaveLength(CLAUDE_STDERR_TAIL_CHARS);
        expect(detail.startsWith('…')).toBe(true);
        expect(detail.endsWith('line119')).toBe(true);
    });

    it('reads local mode errors (ExitCodeError text, signal text) which carry no stderr', () => {
        expect(describeClaudeProcessExit(new Error('Process exited with code: 130'))).toBe('Process exited unexpectedly (code 130)');
        expect(describeClaudeProcessExit(new Error('Process terminated with signal: SIGTERM'))).toBe('Process exited unexpectedly (signal SIGTERM)');
    });

    it('passes any other error text through after the generic prefix, and stays bare with nothing to say', () => {
        expect(describeClaudeProcessExit(new Error('Failed to spawn Claude Code process: spawn node ENOENT')))
            .toBe('Process exited unexpectedly: Failed to spawn Claude Code process: spawn node ENOENT');
        expect(describeClaudeProcessExit('   ')).toBe('Process exited unexpectedly');
        expect(describeClaudeProcessExit(undefined)).toBe('Process exited unexpectedly');
        expect(describeClaudeProcessExit({ not: 'an error' })).toBe('Process exited unexpectedly');
    });
});
