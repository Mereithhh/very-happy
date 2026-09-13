import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CODEX_IDLE_RELEASE_ENV,
    CodexIdleReleaseTimer,
    DEFAULT_CODEX_IDLE_RELEASE_MS,
    resolveCodexIdleReleaseMs,
    shouldReleaseIdleCodex,
} from './codexIdleRelease';

describe('resolveCodexIdleReleaseMs (B-461)', () => {
    it('defaults to five minutes when the override is missing or garbage', () => {
        expect(resolveCodexIdleReleaseMs(undefined)).toBe(DEFAULT_CODEX_IDLE_RELEASE_MS);
        expect(resolveCodexIdleReleaseMs('')).toBe(DEFAULT_CODEX_IDLE_RELEASE_MS);
        expect(resolveCodexIdleReleaseMs('soon')).toBe(DEFAULT_CODEX_IDLE_RELEASE_MS);
        expect(resolveCodexIdleReleaseMs('-1')).toBe(DEFAULT_CODEX_IDLE_RELEASE_MS);
        expect(DEFAULT_CODEX_IDLE_RELEASE_MS).toBe(5 * 60 * 1000);
    });

    it('honours a numeric override and treats 0 as disabled', () => {
        expect(resolveCodexIdleReleaseMs('1500')).toBe(1500);
        expect(resolveCodexIdleReleaseMs('0')).toBe(0);
        expect(CODEX_IDLE_RELEASE_ENV).toBe('HAPPY_CODEX_IDLE_RELEASE_MS');
    });
});

describe('shouldReleaseIdleCodex (B-461)', () => {
    const idle = { turnActive: false, queueSize: 0, shouldExit: false, abortInProgress: false };

    it('releases only when nothing is running, queued, aborting or exiting', () => {
        expect(shouldReleaseIdleCodex(idle)).toBe(true);
        expect(shouldReleaseIdleCodex({ ...idle, turnActive: true })).toBe(false);
        expect(shouldReleaseIdleCodex({ ...idle, queueSize: 1 })).toBe(false);
        expect(shouldReleaseIdleCodex({ ...idle, abortInProgress: true })).toBe(false);
        expect(shouldReleaseIdleCodex({ ...idle, shouldExit: true })).toBe(false);
    });
});

describe('CodexIdleReleaseTimer (B-461)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires the release once the delay elapses while idle', async () => {
        const release = vi.fn(async () => undefined);
        const timer = new CodexIdleReleaseTimer({ delayMs: 1000, isIdle: () => true, release });

        timer.arm();
        expect(timer.armed).toBe(true);
        await vi.advanceTimersByTimeAsync(999);
        expect(release).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await timer.settle();
        expect(release).toHaveBeenCalledTimes(1);
        expect(timer.armed).toBe(false);
    });

    it('re-arming restarts the countdown and cancel drops it', async () => {
        const release = vi.fn(async () => undefined);
        const timer = new CodexIdleReleaseTimer({ delayMs: 1000, isIdle: () => true, release });

        timer.arm();
        await vi.advanceTimersByTimeAsync(800);
        timer.arm();
        await vi.advanceTimersByTimeAsync(800);
        expect(release).not.toHaveBeenCalled();

        timer.cancel();
        await vi.advanceTimersByTimeAsync(5000);
        expect(release).not.toHaveBeenCalled();
        expect(timer.armed).toBe(false);
    });

    it('re-checks idleness when it fires, so a turn that started meanwhile is left alone', async () => {
        let idle = true;
        const release = vi.fn(async () => undefined);
        const timer = new CodexIdleReleaseTimer({ delayMs: 1000, isIdle: () => idle, release });

        timer.arm();
        idle = false;
        await vi.advanceTimersByTimeAsync(1000);
        await timer.settle();
        expect(release).not.toHaveBeenCalled();
    });

    it('never arms when disabled and reports release errors instead of throwing', async () => {
        const release = vi.fn(async () => undefined);
        const disabled = new CodexIdleReleaseTimer({ delayMs: 0, isIdle: () => true, release });
        disabled.arm();
        expect(disabled.enabled).toBe(false);
        expect(disabled.armed).toBe(false);

        const onError = vi.fn();
        const failing = new CodexIdleReleaseTimer({
            delayMs: 10,
            isIdle: () => true,
            release: async () => { throw new Error('boom'); },
            onError,
        });
        failing.arm();
        await vi.advanceTimersByTimeAsync(10);
        await failing.settle();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    });
});

describe('runCodex idle release wiring (B-461)', () => {
    // Source assertion: the mechanism only protects users if the main loop
    // actually arms the timer after every turn and cancels it on dequeue.
    // Verified with scripts/dev/mutation-check.mjs (see PR).
    const source = readFileSync(join(__dirname, 'runCodex.ts'), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');

    it('builds the timer from the env override and the shared idle predicate', () => {
        expect(source).toContain('resolveCodexIdleReleaseMs(process.env[CODEX_IDLE_RELEASE_ENV])');
        expect(source).toContain('isIdle: () => shouldReleaseIdleCodex({');
        expect(source).toContain('await client.releaseIdleProcess();');
    });

    it('cancels on dequeue and marks the turn active before /clear handling', () => {
        expect(source).toContain([
            '            idleRelease.cancel();',
            '            turnActive = true;',
            '',
            '            if (isCodexClearText(message.message)) {',
        ].join('\n'));
    });

    it('re-arms after a turn (finally) and after /clear, arms at startup, and stops on exit', () => {
        expect(source).toContain([
            '                turnActive = false;',
            '                idleRelease.arm();',
            "                logActiveHandles('after-turn');",
        ].join('\n'));
        expect(source).toContain([
            '                turnActive = false;',
            '                idleRelease.arm();',
            '                continue;',
        ].join('\n'));
        expect(source).toContain([
            '        idleRelease.arm();',
            '',
            '        while (!shouldExit) {',
        ].join('\n'));
        expect(source).toContain([
            '        idleRelease.cancel();',
            "        logger.debug('[codex]: client.disconnect begin');",
        ].join('\n'));
    });

    it('reconnects a released app-server before reading sandboxEnabled for the turn', () => {
        expect(source).toContain([
            '                await client.ensureConnected();',
            '',
            '                const sandboxManagedByHappy = client.sandboxEnabled;',
        ].join('\n'));
    });
});
