/**
 * TitleGenerator gating — shared by runClaude and runAcp (pi-acp sessions).
 * Pins the contract the ACP runner relies on: a title the agent already set
 * through `change_title` (metadata.summary) is never overwritten, even when it
 * appears while the one-shot is in flight.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/projectPath', () => ({ projectPath: () => '/nonexistent' }));

import { TitleGenerator, suggestTitleForPrompt } from './titleGenerator';

function fakeChild(stdout: string) {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.kill = vi.fn();
    setTimeout(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', 0);
    }, 0);
    return child;
}

function fakeSession(summary?: string) {
    const metadata: { summary?: { text: string } } = summary ? { summary: { text: summary } } : {};
    return {
        metadata,
        getMetadata: vi.fn(() => metadata),
        sendClaudeSessionMessage: vi.fn(),
    };
}

describe('TitleGenerator', () => {
    beforeEach(() => {
        mocks.spawn.mockReset();
        mocks.spawn.mockImplementation(() => fakeChild('Repo summary\n'));
    });

    it('sets a title from the first non-empty prompt and only runs once', async () => {
        const session = fakeSession();
        const generator = new TitleGenerator(session as never);
        generator.maybeGenerate('');
        generator.maybeGenerate('Summarise the repo');
        generator.maybeGenerate('second prompt');
        await vi.waitFor(() => expect(session.sendClaudeSessionMessage).toHaveBeenCalledTimes(1));
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(session.sendClaudeSessionMessage.mock.calls[0][0]).toMatchObject({ type: 'summary', summary: 'Repo summary' });
    });

    it('does nothing when the agent already set a title (change_title)', async () => {
        const session = fakeSession('Agent chosen title');
        new TitleGenerator(session as never).maybeGenerate('Summarise the repo');
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(session.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });

    it('does not overwrite a title the agent set while the one-shot was running', async () => {
        const session = fakeSession();
        mocks.spawn.mockImplementation(() => {
            session.metadata.summary = { text: 'Agent chosen title' };
            return fakeChild('Generated title\n');
        });
        new TitleGenerator(session as never).maybeGenerate('Summarise the repo');
        await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(session.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});

describe('suggestTitleForPrompt (B-500 terminal bridge)', () => {
    beforeEach(() => {
        mocks.spawn.mockReset();
        mocks.spawn.mockImplementation(() => fakeChild('"Fix terminal auto-title."\n'));
    });

    it('runs the same haiku one-shot as the session generator and returns the sanitized title', async () => {
        await expect(suggestTitleForPrompt('please fix the terminal auto title')).resolves.toBe('Fix terminal auto-title');
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        const [, args] = mocks.spawn.mock.calls[0];
        expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
        expect(args[3]).toContain('please fix the terminal auto title');
    });

    it('stamps HAPPY_MANAGED=1 on the one-shot so a user-wide terminal-mirror hook ignores it', async () => {
        // The bridge inherits VH_TERMINAL_ID from the web terminal; without the
        // stamp the SessionStart hook would bind a mirror session to a one-shot.
        await suggestTitleForPrompt('hello');
        const [, , options] = mocks.spawn.mock.calls[0];
        expect(options.env.HAPPY_MANAGED).toBe('1');
        expect(options.stdio).toEqual(['ignore', 'pipe', 'ignore']);
    });

    it('resolves null on garbage or failure instead of inventing a title', async () => {
        mocks.spawn.mockImplementation(() => fakeChild('New chat\n'));
        await expect(suggestTitleForPrompt('x')).resolves.toBeNull();
        mocks.spawn.mockImplementation(() => { throw new Error('ENOENT'); });
        await expect(suggestTitleForPrompt('x')).resolves.toBeNull();
    });
});
