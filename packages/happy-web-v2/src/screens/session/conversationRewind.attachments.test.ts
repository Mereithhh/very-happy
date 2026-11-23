// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/apiSocket', () => ({ apiSocket: {} }));
vi.mock('@/sync/storage', () => ({ storage: {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
import type { Message } from '@/sync/typesMessage';
import type { ReusableAttachment } from '@/sync/attachmentTypes';
import { codexRewindReconcile, rewindConversation, RewindFailure, userTurnStarts, type RewindDeps } from './conversationRewind';
import { extractUserAttachments } from './chatTurns';
import { reusableAttachmentsFromFileEvents } from './UserAttachments';

/**
 * B-961c: a small transcript that behaves like the store — sendMessage queues
 * the `file` events before the text (smaller seqs), a tombstone hides
 * [fromSeq, toSeq), the screen groups the leading `file` run as the prompt's
 * attachments.
 */
function transcript() {
    let seq = 0;
    let n = 0;
    const all: Message[] = [];
    const drops: Array<{ fromSeq: number; toSeq?: number }> = [];
    const file = (ref: string): Message => ({
        kind: 'tool-call', id: `f${++n}`, localId: null, createdAt: ++seq, seq, children: [],
        tool: { name: 'file', state: 'completed', input: { ref, name: 'red.png', mimeType: 'image/png', size: 9, image: { width: 4, height: 4 } }, createdAt: seq, startedAt: seq, completedAt: seq, description: null },
    } as Message);
    const send = (text: string, refs: string[]) => {
        for (const ref of refs) all.push(file(ref));
        all.push({ kind: 'user-text', id: `u${++n}`, localId: `l${n}`, createdAt: ++seq, seq, text } as Message);
        all.push({ kind: 'agent-text', id: `a${++n}`, localId: null, createdAt: ++seq, seq, text: 'red' } as Message);
    };
    const visible = () => all.filter((m) => !drops.some((d) => (m.seq as number) >= d.fromSeq && (d.toSeq === undefined || (m.seq as number) < d.toSeq)));
    const newestFirst = () => [...visible()].reverse();
    const prompts = () => {
        const { messages, attachments } = extractUserAttachments(visible());
        return messages.filter((m) => m.kind === 'user-text').map((m) => ({ message: m, files: attachments.get(m.id) ?? [] }));
    };
    const sent: ReusableAttachment[][] = [];
    const deps: RewindDeps = {
        rpc: vi.fn(async () => ({ ok: true })),
        // The tombstone's own seq closes an open range (its echo, like the reducer).
        recordDrop: vi.fn(async (_s, drop) => { drops.push({ ...drop, toSeq: drop.toSeq ?? ++seq }); }),
        send: vi.fn(async (_s, text, attachments) => {
            sent.push(attachments ?? []);
            send(text, (attachments ?? []).map((a: ReusableAttachment) => a.ref));
            return 'receipt';
        }),
        userSeqs: () => [...userTurnStarts(newestFirst()).values()],
        turnStart: (_s, s) => userTurnStarts(newestFirst()).get(s) ?? s,
        newRequestId: () => 'req',
    };
    return { send, prompts, deps, sent, newestFirst };
}

/** The prompt's own attachments, as MessageActions / ChatList pass them. */
const filesOf = (row: { files: Message[] }) => reusableAttachmentsFromFileEvents(row.files as never);

describe('rewind keeps one attachment per prompt (B-961c)', () => {
    it('retry → edit → retry: always one thumbnail, one file re-sent', async () => {
        const t = transcript();
        t.send('what colour?', ['ref-red']);
        for (const text of ['what colour?', 'what colour? EDIT', 'what colour? EDIT']) {
            const [row] = t.prompts();
            await rewindConversation('s', row.message as never, { action: 'edit', text }, t.deps, filesOf(row));
            const after = t.prompts();
            expect(after).toHaveLength(1);
            expect(after[0].files).toHaveLength(1);
            expect(t.sent.at(-1)).toHaveLength(1);
        }
    });

    it('the tombstone starts at the prompt\'s first file event', async () => {
        const t = transcript();
        t.send('a', []);
        t.send('b', ['r1', 'r2']);
        const row = t.prompts()[1];
        await rewindConversation('s', row.message as never, { action: 'edit', text: 'b2' }, t.deps, filesOf(row));
        expect(t.deps.recordDrop).toHaveBeenCalledWith('s', { fromSeq: 3, reason: 'edit', requestId: 'req' });
    });

    it('delete hides the prompt with its files, and stops before the next prompt\'s files', async () => {
        const t = transcript();
        t.send('a', ['r1']);
        t.send('b', ['r2']);
        await rewindConversation('s', t.prompts()[0].message as never, { action: 'delete' }, t.deps);
        const after = t.prompts();
        expect(after.map((p) => p.message.kind === 'user-text' && p.message.text)).toEqual(['b']);
        expect(after[0].files).toHaveLength(1);
        expect(extractUserAttachments(t.newestFirst().reverse()).messages.some((m) => m.kind === 'tool-call')).toBe(false);
    });

    it('a Codex reconcile hides from the first file event too', () => {
        const t = transcript();
        t.send('a', ['r1']);
        const target = t.prompts()[0].message;
        const session = { metadata: { flavor: 'codex', rewind: { state: 'applied', requestId: 'q', sourceId: target.localId, action: 'edit' } } } as never;
        expect(codexRewindReconcile(session, t.newestFirst())).toEqual({ requestId: 'q', reason: 'edit', fromSeq: 1 });
    });

    it('a turn an older rewind left doubled shows and re-sends its file once', () => {
        const t = transcript();
        t.send('a', ['ref-red', 'ref-red']);
        const [row] = t.prompts();
        expect(row.files).toHaveLength(1);
        expect(filesOf(row)).toHaveLength(1);
    });

    it('attachment-gone names the files: the wrapper\'s list, else the request\'s', async () => {
        const t = transcript();
        const named = await rewindConversation('s', { seq: 1, localId: 'l', text: 'x' }, { action: 'edit', text: 'y' },
            { ...t.deps, rpc: vi.fn(async () => ({ ok: false, code: 'attachment-gone', error: 'gone', missing: ['red.png'] })) },
            [{ ref: 'r', name: 'red.png', size: 1 }, { ref: 'r2', name: 'blue.png', size: 1 }]).catch((e) => e);
        expect(named).toBeInstanceOf(RewindFailure);
        expect(named.files).toEqual(['red.png']);
        const fallback = await rewindConversation('s', { seq: 1, localId: 'l', text: 'x' }, { action: 'edit', text: 'y' },
            { ...t.deps, rpc: vi.fn(async () => ({ ok: false, code: 'attachment-gone', error: 'gone' })) },
            [{ ref: 'r', name: 'red.png', size: 1 }]).catch((e) => e);
        expect(fallback.files).toEqual(['red.png']);
    });
});
