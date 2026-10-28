import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkQuery = vi.hoisted(() => vi.fn((_params: any) => ({ async *[Symbol.asyncIterator]() {} })));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
    query: sdkQuery,
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from './query';

describe('Claude SDK query adapter', () => {
    it('forwards child text for the nested transcript', () => {
        query({ prompt: 'hello' });
        expect(sdkQuery.mock.calls[0][0].options.forwardSubagentText).toBe(true);
    });
    beforeEach(() => sdkQuery.mockClear());
    it('enables file checkpoints and replays their actual SDK user UUIDs', () => {
        query({ prompt: 'hello' });
        expect(sdkQuery.mock.calls[0][0].options).toMatchObject({ enableFileCheckpointing: true, extraArgs: { 'replay-user-messages': null } });
    });

    it('asks Claude Code for its session_state_changed frames, unless the operator decided otherwise (B-631)', () => {
        query({ prompt: 'hello' });
        expect(sdkQuery.mock.calls[0][0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
        query({ prompt: 'hello', options: { env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '' } } });
        expect(sdkQuery.mock.calls[1][0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('');
    });

    it('sets the SDK safety acknowledgement for bypassPermissions', () => {
        query({ prompt: 'hello', options: { permissionMode: 'bypassPermissions' } });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
        }));
    });

    it('can opt in to a later live bypass without starting in bypass mode', () => {
        query({ prompt: 'hello', options: { permissionMode: 'plan', allowDangerouslySkipPermissions: true } });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            permissionMode: 'plan',
            allowDangerouslySkipPermissions: true,
        }));
    });

    it('latches a source signal that was already aborted', () => {
        const source = new AbortController();
        source.abort('already stopped');
        query({ prompt: 'hello', options: { abort: source.signal } });
        const target = sdkQuery.mock.calls[0][0].options.abortController;
        expect(target?.signal.aborted).toBe(true);
        expect(target?.signal.reason).toBe('already stopped');
    });

    it('forwards blocking interaction callbacks and declared dialog kinds', () => {
        const onElicitation = vi.fn();
        const onUserDialog = vi.fn();
        query({
            prompt: 'hello',
            options: { onElicitation, onUserDialog, supportedDialogKinds: ['refusal_fallback_prompt'] },
        });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            onElicitation,
            onUserDialog,
            supportedDialogKinds: ['refusal_fallback_prompt'],
        }));
    });

    it('forwards side-question fork options verbatim (B-283)', () => {
        query({
            prompt: 'hello',
            options: { resume: 'abc', forkSession: true, tools: [], persistSession: false, includePartialMessages: true },
        });
        expect(sdkQuery.mock.calls[0][0].options).toEqual(expect.objectContaining({
            resume: 'abc',
            forkSession: true,
            tools: [],
            persistSession: false,
            includePartialMessages: true,
        }));
    });

    it('layers explicit env over process.env for the spawned Claude', () => {
        query({ prompt: 'hello', options: { env: { ANTHROPIC_BASE_URL: 'https://hub.example', HAPPY_MANAGED: '1' } } });
        const env = sdkQuery.mock.calls[0][0].options.env;
        expect(env.ANTHROPIC_BASE_URL).toBe('https://hub.example');
        expect(env.HAPPY_MANAGED).toBe('1');
        expect(env.PATH).toBe(process.env.PATH);
    });

    describe('prompt cache TTL default (B-840)', () => {
        const ttlKeys = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'HAPPY_CLAUDE_PROMPT_CACHE_TTL', 'HAPPY_SPAWNED_BY'];
        beforeEach(() => {
            for (const key of ttlKeys) vi.stubEnv(key, '');
            vi.stubEnv('CLAUDE_CONFIG_DIR', '/nonexistent-vh-b841');
        });
        afterEach(() => vi.unstubAllEnvs());

        it('asks the spawned Claude for a 1h main-conversation cache', () => {
            query({ prompt: 'hello', options: { cwd: '/nonexistent-vh-b841-repo' } });
            const env = sdkQuery.mock.calls[0][0].options.env;
            expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
            expect(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBe('');
        });

        it('keeps a TTL chosen in the session cwd project settings, and never touches process.env', () => {
            const repo = mkdtempSync(join(tmpdir(), 'vh-b841-'));
            try {
                mkdirSync(join(repo, '.claude'));
                writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ promptCacheTtl: '5m' }));
                query({ prompt: 'hello', options: { cwd: repo } });
                expect(sdkQuery.mock.calls[0][0].options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('');
                query({ prompt: 'hello', options: { cwd: join(repo, 'elsewhere') } });
                expect(sdkQuery.mock.calls[1][0].options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
                expect(process.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('');
            } finally {
                rmSync(repo, { recursive: true, force: true });
            }
        });

        it('keeps a user TTL from the session env', () => {
            query({ prompt: 'hello', options: { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } } });
            expect(sdkQuery.mock.calls[0][0].options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m');
        });

        it('injects nothing when the daemon opted out', () => {
            vi.stubEnv('HAPPY_CLAUDE_PROMPT_CACHE_TTL', 'auto');
            query({ prompt: 'hello' });
            expect(sdkQuery.mock.calls[0][0].options.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('');
        });
    });

    it('leaves fork options undefined for ordinary queries', () => {
        query({ prompt: 'hello', options: { resume: 'abc' } });
        const options = sdkQuery.mock.calls[0][0].options;
        expect(options.forkSession).toBeUndefined();
        expect(options.tools).toBeUndefined();
        expect(options.persistSession).toBeUndefined();
    });

    it('grants the SDK access to staged attachment directories', () => {
        query({ prompt: 'hello', options: { additionalDirectories: ['/private/chat-files'] } });
        expect(sdkQuery.mock.calls[0][0].options.additionalDirectories).toEqual(['/private/chat-files']);
    });

    describe('root sandbox assertion (--dangerously-skip-permissions under root)', () => {
        const realGetuid = process.getuid;
        afterEach(() => {
            if (realGetuid) process.getuid = realGetuid;
            else delete (process as { getuid?: () => number }).getuid;
            delete process.env.IS_SANDBOX;
        });

        it('sets IS_SANDBOX=1 when running as root with the dangerous opt-in on', () => {
            process.getuid = () => 0;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'default', allowDangerouslySkipPermissions: true } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBe('1');
        });

        it('does not set IS_SANDBOX when not root', () => {
            process.getuid = () => 1000;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'default', allowDangerouslySkipPermissions: true } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBeUndefined();
        });

        it('does not set IS_SANDBOX when the dangerous opt-in is off', () => {
            process.getuid = () => 0;
            delete process.env.IS_SANDBOX;
            query({ prompt: 'hi', options: { permissionMode: 'plan' } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBeUndefined();
        });

        it('never overrides an explicit IS_SANDBOX (operator may forbid with "0")', () => {
            process.getuid = () => 0;
            process.env.IS_SANDBOX = '0';
            query({ prompt: 'hi', options: { permissionMode: 'bypassPermissions' } });
            expect(sdkQuery.mock.calls[0][0].options.env.IS_SANDBOX).toBe('0');
        });
    });
});
