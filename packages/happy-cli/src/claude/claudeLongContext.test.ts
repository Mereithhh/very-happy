import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    clearLongContextVerdict,
    createLongContextPolicy,
    longContextKey,
    longContextRejectionFrom,
    messageModelIntent,
    readLongContextVerdict,
    withoutRefusedLongContext,
    writeLongContextVerdict,
} from './claudeLongContext';

// Frames as Claude Code 2.1.304 emitted them against the B-883b stub provider.
const reply = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', is_api_error_message: true, api_error_status: 429,
    message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
});

describe('longContextRejectionFrom', () => {
    it('reads the 429 "Extra usage is required for long context" reply while running a [1m] id', () => {
        expect(longContextRejectionFrom(reply('API Error: Request rejected (429) · Extra usage is required for long context requests.'), 'claude-opus-5-5[1m]'))
            .toEqual({ model: 'claude-opus-5-5[1m]', plain: 'claude-opus-5-5', reason: 'API Error: Request rejected (429) · Extra usage is required for long context requests.' });
        // 403: Claude Code retries 10 times, then reports it as an auth failure.
        expect(longContextRejectionFrom(reply('Failed to authenticate. API Error: 403 Your organization does not have access to the 1M context window.', { error: 'authentication_failed', api_error_status: 403 }), 'claude-opus-5-5[1m]')?.plain)
            .toBe('claude-opus-5-5');
        expect(longContextRejectionFrom(reply('Usage credits are required for long context requests.'), 'claude-sonnet-5[1m]')?.plain).toBe('claude-sonnet-5');
    });

    it('ignores everything else', () => {
        const text = 'Extra usage is required for long context requests.';
        expect(longContextRejectionFrom(reply(text), 'claude-opus-5-5')).toBeNull();
        expect(longContextRejectionFrom(reply(text), undefined)).toBeNull();
        expect(longContextRejectionFrom(reply('API Error: Request rejected (429) · rate limited'), 'claude-opus-5-5[1m]')).toBeNull();
        expect(longContextRejectionFrom(reply(text, { parent_tool_use_id: 'toolu_1' }), 'claude-opus-5-5[1m]')).toBeNull();
        expect(longContextRejectionFrom(reply(text, { api_error_status: 500 }), 'claude-opus-5-5[1m]')).toBeNull();
        expect(longContextRejectionFrom(reply(text, { error: undefined }), 'claude-opus-5-5[1m]')).toBeNull();
        expect(longContextRejectionFrom({ type: 'result', is_error: true, result: text }, 'claude-opus-5-5[1m]')).toBeNull();
    });
});

describe('machine memory', () => {
    it('keys by provider (settings env over process env) and login dir', () => {
        expect(longContextKey({})).toBe('anthropic|~/.claude');
        expect(longContextKey({ ANTHROPIC_BASE_URL: 'https://a', CLAUDE_CONFIG_DIR: '/c' })).toBe('https://a|/c');
        expect(longContextKey({ ANTHROPIC_BASE_URL: 'https://a' }, { ANTHROPIC_BASE_URL: 'https://b' })).toBe('https://b|~/.claude');
    });

    it('round-trips per key and survives a corrupt file', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'lc-')), 'claude-long-context.json');
        expect(readLongContextVerdict(path, 'k')).toBeNull();
        writeLongContextVerdict(path, 'k', { reason: 'r', at: 1 });
        writeLongContextVerdict(path, 'other', { reason: 'o', at: 2 });
        expect(readLongContextVerdict(path, 'k')).toEqual({ reason: 'r', at: 1 });
        expect(JSON.parse(readFileSync(path, 'utf8')).unsupported.other).toEqual({ reason: 'o', at: 2 });
        clearLongContextVerdict(path, 'k');
        expect(readLongContextVerdict(path, 'k')).toBeNull();
        expect(readLongContextVerdict(path, 'other')).toEqual({ reason: 'o', at: 2 });
    });
});

describe('createLongContextPolicy', () => {
    const session = (modelIntent: string | null) => {
        let metadata: Record<string, unknown> = { modelIntent };
        return { getMetadata: () => metadata as any, updateMetadata: (fn: (m: any) => any) => { metadata = fn(metadata); }, get metadata() { return metadata; } };
    };
    const rejection = { model: 'claude-opus-5-5[1m]', plain: 'claude-opus-5-5', reason: 'Extra usage is required for long context requests.' };

    it('records the verdict either way; retries only when following latest', () => {
        for (const [intent, decision] of [['latest', 'retry'], ['claude-opus-5-5[1m]', 'fail'], ['default', 'fail'], [null, 'fail']] as const) {
            const s = session(intent);
            const write = vi.fn();
            expect(createLongContextPolicy({ session: s, storePath: '/x', key: 'k', now: () => 7, write }).onRejected(rejection)).toBe(decision);
            expect(write).toHaveBeenCalledWith('/x', 'k', { reason: rejection.reason, at: 7 });
            expect(s.metadata.longContextUnsupported).toEqual({ reason: rejection.reason, at: 7 });
        }
    });

    it('following latest, the session keeps the plain id from now on (stickyModel)', () => {
        const s = session('latest');
        s.updateMetadata((m: any) => ({ ...m, stickyModel: 'claude-opus-5-5[1m]' }));
        createLongContextPolicy({ session: s, storePath: '/x', key: 'k', write: vi.fn() }).onRejected(rejection);
        expect(s.metadata.stickyModel).toBe('claude-opus-5-5');
        const pinned = session('claude-opus-5-5[1m]');
        pinned.updateMetadata((m: any) => ({ ...m, stickyModel: 'claude-opus-5-5[1m]' }));
        createLongContextPolicy({ session: pinned, storePath: '/x', key: 'k', write: vi.fn() }).onRejected(rejection);
        expect(pinned.metadata.stickyModel).toBe('claude-opus-5-5[1m]');
    });

    it('an answered [1m] request forgets the refusal (account upgraded); nothing to forget does nothing', () => {
        const s = session('claude-opus-5-5[1m]');
        const clear = vi.fn();
        const policy = createLongContextPolicy({ session: s, storePath: '/x', key: 'k', now: () => 7, write: vi.fn(), clear });
        policy.onServed();
        expect(clear).not.toHaveBeenCalled();
        policy.onRejected(rejection);
        policy.onServed();
        expect(clear).toHaveBeenCalledWith('/x', 'k');
        expect(s.metadata.longContextUnsupported).toBeNull();
    });

    it('a failed write still records it on the session', () => {
        const s = session('latest');
        const policy = createLongContextPolicy({ session: s, storePath: '/x', key: 'k', now: () => 1, write: () => { throw new Error('EROFS'); } });
        expect(policy.onRejected(rejection)).toBe('retry');
        expect(s.metadata.longContextUnsupported).toEqual({ reason: rejection.reason, at: 1 });
    });
});

describe('messageModelIntent', () => {
    it('an old Web\'s bare [1m] model is an explicit pick, not the session\'s latest', () => {
        expect(messageModelIntent({ model: 'claude-opus-5-5[1m]', modelIntent: 'latest' }, 'x')).toBe('latest');
        expect(messageModelIntent({ model: 'claude-opus-5-5[1m]' }, 'latest')).toBe('claude-opus-5-5[1m]');
        expect(messageModelIntent({}, 'latest')).toBe('latest');
        expect(messageModelIntent(undefined, 'latest')).toBe('latest');
    });
});

describe('withoutRefusedLongContext', () => {
    const verdict = { reason: 'r', at: 1 };
    it('drops [1m] only for follow-latest on a machine known to refuse it', () => {
        expect(withoutRefusedLongContext('claude-opus-5-5[1m]', 'latest', verdict)).toBe('claude-opus-5-5');
        expect(withoutRefusedLongContext('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]', verdict)).toBe('claude-opus-5-5[1m]');
        expect(withoutRefusedLongContext('claude-opus-5-5[1m]', 'latest', null)).toBe('claude-opus-5-5[1m]');
        expect(withoutRefusedLongContext('claude-opus-5-5', 'latest', verdict)).toBe('claude-opus-5-5');
        expect(withoutRefusedLongContext(undefined, 'latest', verdict)).toBeUndefined();
    });
});
