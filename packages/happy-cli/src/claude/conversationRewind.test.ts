import { describe, expect, it, vi } from 'vitest';
import { createConversationRewind, type ConversationRewindDeps } from './conversationRewind';
import { ConversationRewindError } from './utils/claudeTranscriptRewind';

function deps(overrides: Partial<ConversationRewindDeps> = {}) {
    const base: ConversationRewindDeps = {
        claudeSessionId: () => 'claude-1',
        projectDir: () => '/p',
        isThinking: () => false,
        stopTurn: vi.fn(async () => {}),
        waitIdle: vi.fn(async () => true),
        aliases: () => ['alias-1'],
        switchConversation: vi.fn(async () => {}),
        rewrite: vi.fn(async () => 'claude-2'),
    };
    return { ...base, ...overrides };
}

describe('conversation-rewind', () => {
    it('rewrites with the source id first, then aliases, and switches to the new conversation', async () => {
        const d = deps();
        const result = await createConversationRewind(d)({ action: 'delete', sourceId: 'web-1', text: 'hi' });
        expect(result).toEqual({ ok: true, action: 'delete', freshConversation: false });
        expect(d.rewrite).toHaveBeenCalledWith('/p', 'claude-1', 'delete', { uuids: ['web-1', 'alias-1'], text: 'hi' });
        expect(d.switchConversation).toHaveBeenCalledWith('claude-2');
    });

    it('stops a running turn first and refuses if it does not go idle', async () => {
        const d = deps({ isThinking: () => true, waitIdle: vi.fn(async () => false) });
        const result = await createConversationRewind(d)({ action: 'edit', sourceId: 'web-1' });
        expect(d.stopTurn).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ ok: false, code: 'running' });
        expect(d.switchConversation).not.toHaveBeenCalled();
    });

    it('starts fresh when nothing would remain', async () => {
        const d = deps({ rewrite: vi.fn(async () => null) });
        expect(await createConversationRewind(d)({ action: 'edit', sourceId: 'web-1' })).toEqual({ ok: true, action: 'edit', freshConversation: true });
        expect(d.switchConversation).toHaveBeenCalledWith(null);
    });

    it('maps resolution failures to typed errors and never switches', async () => {
        const d = deps({ rewrite: vi.fn(async () => { throw new ConversationRewindError('ambiguous', 'dup'); }) });
        expect(await createConversationRewind(d)({ action: 'edit', text: 'x' })).toEqual({ ok: false, code: 'ambiguous', error: 'dup' });
        expect(d.switchConversation).not.toHaveBeenCalled();
    });

    it('rejects invalid input, a missing conversation, and concurrent requests', async () => {
        expect(await createConversationRewind(deps())({ action: 'nope', sourceId: 'x' })).toMatchObject({ code: 'invalid' });
        expect(await createConversationRewind(deps())({ action: 'edit' })).toMatchObject({ code: 'invalid' });
        expect(await createConversationRewind(deps({ claudeSessionId: () => null }))({ action: 'edit', sourceId: 'x' })).toMatchObject({ code: 'no-conversation' });
        let release!: () => void;
        const slow = deps({ rewrite: vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('n'); })) });
        const rewind = createConversationRewind(slow);
        const first = rewind({ action: 'edit', sourceId: 'a' });
        expect(await rewind({ action: 'edit', sourceId: 'b' })).toMatchObject({ code: 'busy' });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        release();
        expect(await first).toMatchObject({ ok: true });
    });

    it('B-544: with a requestId, marks pending BEFORE the switch and acks only after the record is persisted', async () => {
        const order: string[] = [];
        let persist!: () => void;
        const beginPending = vi.fn(() => { order.push('begin'); return new Promise<void>((resolve) => { persist = () => { order.push('persisted'); resolve(); }; }); });
        const d = deps({ beginPending, now: () => 42, switchConversation: vi.fn(async () => { order.push('switch'); }) });
        const pending = createConversationRewind(d)({ action: 'edit', sourceId: 'web-1', requestId: 'req_1-a' });
        await vi.waitFor(() => expect(order).toEqual(['begin', 'switch']));
        let acked = false;
        void pending.then(() => { acked = true; });
        await Promise.resolve();
        expect(acked).toBe(false);
        persist();
        expect(await pending).toEqual({ ok: true, action: 'edit', freshConversation: false });
        expect(order).toEqual(['begin', 'switch', 'persisted']);
        expect(beginPending).toHaveBeenCalledWith({ requestId: 'req_1-a', action: 'edit', sourceClaudeSessionId: 'claude-1', claudeSessionId: 'claude-2', at: 42 });
    });

    it('B-544: old web (no requestId) keeps B-528 semantics — nothing pending', async () => {
        const beginPending = vi.fn(async () => {});
        const d = deps({ beginPending });
        expect(await createConversationRewind(d)({ action: 'delete', sourceId: 'web-1' })).toMatchObject({ ok: true });
        expect(await createConversationRewind(d)({ action: 'delete', sourceId: 'web-1', requestId: 'bad id with spaces' })).toMatchObject({ ok: true });
        expect(beginPending).not.toHaveBeenCalled();
    });
});
