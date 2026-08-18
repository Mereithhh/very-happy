/**
 * The point of these tests is the ONE rule that keeps a broken provider
 * debuggable: whatever the provider printed on stderr must reach the screen
 * verbatim. Everything else here just pins "all six codes say something".
 */
import { describe, it, expect } from 'vitest';
import type { TodoFailure, TodoFailureCode } from '@/sync/todoFailure';
import type { t as translate } from '@/text';
import { isSetupNeeded, todoFailureText } from './todoFailureText';

/** Fake translator: echoes `key(params)` so we can assert on key + payload
 *  without booting the real i18n module (it reads persisted settings). */
const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${JSON.stringify(params)})` : key) as unknown as typeof translate;

const fail = (code: TodoFailureCode, error = 'boom'): TodoFailure => ({ ok: false, code, error });

const ALL_CODES: TodoFailureCode[] = [
    'not-configured',
    'unsupported',
    'timeout',
    'provider-error',
    'bad-output',
    'unknown',
];

describe('todoFailureText', () => {
    it('has a distinct, non-empty message for every failure code', () => {
        const messages = ALL_CODES.map((code) => todoFailureText(t, fail(code)));
        expect(messages.every((m) => m.length > 0)).toBe(true);
        expect(new Set(messages).size).toBe(ALL_CODES.length);
    });

    it('shows the provider stderr verbatim — never "unknown error"', () => {
        const stderr = "Traceback: KeyError: 'items'\nexit 2";
        const out = todoFailureText(t, fail('provider-error', stderr));
        expect(out).toContain('todos.providerError');
        expect(out).toContain('KeyError');
        expect(out).not.toContain('unknown');
    });

    it('carries the detail through for bad-output and unknown too', () => {
        expect(todoFailureText(t, fail('bad-output', 'not JSON: <html>'))).toContain('not JSON');
        expect(todoFailureText(t, fail('unknown', 'socket closed'))).toContain('socket closed');
    });

    it('maps unsupported and timeout to their own copy (no raw error dumped)', () => {
        expect(todoFailureText(t, fail('unsupported'))).toBe('todos.unsupported');
        expect(todoFailureText(t, fail('timeout'))).toBe('todos.timeout');
    });

    it('falls back to the unknown copy for a code from a newer daemon', () => {
        expect(todoFailureText(t, fail('brand-new' as TodoFailureCode, 'huh'))).toContain('todos.unknownError');
    });
});

describe('isSetupNeeded', () => {
    it('is true only for not-configured (the feature is off, nothing is broken)', () => {
        for (const code of ALL_CODES) {
            expect(isSetupNeeded(fail(code))).toBe(code === 'not-configured');
        }
    });
});
