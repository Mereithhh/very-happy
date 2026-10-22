import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionItemPatch, AttentionItemPost, AttentionItemResolve } from '@slopus/happy-wire';
import { AttentionUnsupportedError, type AttentionClient } from './client';
import { createLeadBoard, formatBoardDigest, isOwnerMessage, ownerQuestionTitle, parseSince } from './leadBoard';

function item(over: Partial<AttentionItem> = {}): AttentionItem {
    return {
        id: 'i1', sessionId: 's1', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: null, title: 't', bodyMd: null,
        options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open',
        ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null,
        pushedAt: null, version: 0, ...over,
    };
}

/** In-memory W0 server: enough of the S-1 semantics to drive the wrapper. */
function fakeServer(opts: { supported?: boolean } = {}) {
    const calls: Array<{ op: string; id?: string; body?: unknown }> = [];
    const items = new Map<string, AttentionItem>();
    let seq = 0;
    let disabled = opts.supported === false;
    const client: AttentionClient = {
        isDisabled: () => disabled,
        probe: async () => !disabled,
        post: async (input: AttentionItemPost) => {
            calls.push({ op: 'post', body: input });
            if (disabled) throw new AttentionUnsupportedError();
            const id = `item-${++seq}`;
            const created = item({ id, source: input.source, kind: input.kind, title: input.title, key: input.key ?? null, anchor: input.anchor ?? null, inferred: input.inferred === true });
            items.set(id, created);
            return { item: created, created: true };
        },
        patch: async (id: string, patch: AttentionItemPatch) => {
            calls.push({ op: 'patch', id, body: patch });
            const next = { ...items.get(id)!, ...(patch.state ? { state: patch.state } : {}), ...(patch.firstReply ? { firstReply: patch.firstReply } : {}) };
            items.set(id, next);
            return { item: next };
        },
        resolve: async (id: string, input: AttentionItemResolve) => {
            calls.push({ op: 'resolve', id, body: input });
            const next = { ...items.get(id)!, state: input.outcome === 'answered' ? 'answered' : 'resolved', resolvedBy: input.by ?? 'lead' };
            items.set(id, next);
            return { item: next };
        },
        list: async (query) => {
            calls.push({ op: 'list', body: query });
            return { items: [...items.values()].filter(i => i.state === 'open' || i.state === 'in_progress') };
        },
    };
    return { client, calls, items, disable: () => { disabled = true; } };
}

function board(server: ReturnType<typeof fakeServer>, opts: { lead?: boolean; autoDetect?: boolean } = {}) {
    let supportedCalls = 0;
    const b = createLeadBoard({
        sessionId: () => 's1',
        client: server.client,
        isLead: async () => opts.lead ?? true,
        autoDetect: async () => opts.autoDetect ?? true,
        onSupported: () => { supportedCalls++; },
    });
    return { b, supportedCalls: () => supportedCalls };
}

const owner = (localId: string, text: string, extra: Record<string, string> = {}) => ({ localId, text, sentFrom: 'web', ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('owner message classification', () => {
    it('counts only a person in a Very Happy client, never board buttons or automated senders', () => {
        expect(isOwnerMessage({ localId: 'abc', sentFrom: 'web' })).toBe(true);
        expect(isOwnerMessage({ localId: 'board-item1-n', sentFrom: 'web' })).toBe(false);
        expect(isOwnerMessage({ localId: 'teams-message-1', sentFrom: 'web' })).toBe(false);
        expect(isOwnerMessage({ localId: 'abc', sentFrom: 'team' })).toBe(false);
        expect(isOwnerMessage({ localId: 'abc', sentFrom: 'session-peer' })).toBe(false);
        expect(isOwnerMessage({ localId: 'abc' })).toBe(false);
    });
    it('titles a question by its first line (≤60 chars) and skips slash commands', () => {
        expect(ownerQuestionTitle('\n  发布说明谁来写？\n细节如下')).toBe('发布说明谁来写？');
        expect(ownerQuestionTitle('x'.repeat(80))).toHaveLength(60);
        expect(ownerQuestionTitle('/compact')).toBeNull();
        expect(ownerQuestionTitle('  ')).toBeNull();
    });
    it('parses since as ISO-8601 or epoch ms', () => {
        expect(parseSince('1700000000000')).toBe(1700000000000);
        expect(parseSince('2026-10-23T00:00:00Z')).toBe(Date.parse('2026-10-23T00:00:00Z'));
        expect(() => parseSince('yesterday')).toThrow();
    });
});

describe('lead board (B-766 C-1)', () => {
    it('turns an owner message into a question, attaches the first reply and settles it as auto-first-reply', async () => {
        const server = fakeServer();
        const { b, supportedCalls } = board(server);
        await b.init();
        expect(supportedCalls()).toBe(1);
        b.onUserMessage(owner('m1', '发布说明谁来写？'));
        b.onUserMessage({ localId: 'teams-message-9', text: 'member idle', sentFrom: 'team' });
        b.onUserMessage(owner('board-i1-x', '［汇报板 · 决定］ → A'));
        await tick();
        const posts = server.calls.filter(c => c.op === 'post');
        expect(posts).toHaveLength(1);
        expect(posts[0].body).toMatchObject({ sessionId: 's1', source: 'owner', kind: 'question', title: '发布说明谁来写？', anchor: { localId: 'm1' }, requestId: 'owner-q-m1' });
        expect((posts[0].body as AttentionItemPost).key).toBeUndefined();

        b.onTurnStart(['m1']);
        b.onAssistantText('我来写，今晚给你。');
        b.onAssistantText('顺便把 changelog 也补了。');
        await b.onTurnEnd();
        const patch = server.calls.find(c => c.op === 'patch')!;
        expect(patch.body).toMatchObject({ firstReply: { localId: 'm1', snippet: '我来写，今晚给你。' } });
        expect(server.calls.find(c => c.op === 'resolve')?.body).toMatchObject({ outcome: 'answered', by: 'auto-first-reply' });
    });

    it('keeps a question the lead moved to in_progress during the turn', async () => {
        const server = fakeServer();
        const { b } = board(server);
        b.onUserMessage(owner('m1', 'Why is CI red?'));
        await tick(); await tick();
        b.onTurnStart(['m1']);
        const questionId = [...server.items.keys()][0];
        await b.update({ id: questionId, state: 'in_progress', request_id: 'r1' });
        b.onAssistantText('Assigned to a member; the result will come to the board.');
        await b.onTurnEnd();
        expect(server.calls.some(c => c.op === 'resolve')).toBe(false);
        expect(server.items.get(questionId)?.state).toBe('in_progress');
    });

    it('leaves a question open when the turn has no text, and only questions of this batch settle', async () => {
        const server = fakeServer();
        const { b } = board(server);
        b.onUserMessage(owner('m1', 'first'));
        b.onUserMessage(owner('m2', 'second'));
        await tick(); await tick();
        b.onTurnStart(['m1']);
        await b.onTurnEnd();
        expect(server.calls.some(c => c.op === 'patch')).toBe(false);
        b.onTurnStart(['m2']);
        b.onAssistantText('answer to second');
        await b.onTurnEnd();
        const patched = server.calls.filter(c => c.op === 'patch').map(c => (c.body as AttentionItemPatch).firstReply?.localId);
        expect(patched).toEqual(['m2']);
    });

    it('does nothing outside a lead session or on a server without the board', async () => {
        for (const server of [fakeServer(), fakeServer({ supported: false })]) {
            const { b } = board(server, { lead: server.client.isDisabled() ? true : false });
            b.onUserMessage(owner('m1', 'hello'));
            b.onTurnStart(['m1']);
            b.onAssistantText('需要你决定：A. x B. y');
            await b.onTurnEnd();
            expect(await b.decorate('prompt')).toBe('prompt');
            expect(server.calls.filter(c => c.op !== 'list')).toEqual([]);
            expect(b.toolsExposed()).toBe(false);
        }
    });

    it('drafts an inferred decision for a prose ask, but not when the lead used the board or the switch is off', async () => {
        const ask = '需要你决定：先发哪个？\nA. server\nB. CLI';
        const server = fakeServer();
        const { b } = board(server);
        b.onTurnStart(['t1']);
        b.onAssistantText(ask);
        await b.onTurnEnd();
        const draft = server.calls.find(c => c.op === 'post')!.body as AttentionItemPost;
        expect(draft).toMatchObject({ source: 'lead', kind: 'decision', inferred: true, title: '需要你决定：先发哪个？', anchor: { localId: 't1' } });
        expect(draft.key).toMatch(/^inferred-/);
        expect(draft.options?.map(o => o.id)).toEqual(['A', 'B']);

        const used = fakeServer();
        const viaBoard = board(used).b;
        viaBoard.onTurnStart(['t2']);
        await viaBoard.post({ kind: 'decision', title: '先发哪个？', options: [{ id: 'A', label: 'server' }, { id: 'B', label: 'CLI' }], request_id: 'r' });
        viaBoard.onAssistantText(ask);
        await viaBoard.onTurnEnd();
        expect(used.calls.filter(c => c.op === 'post')).toHaveLength(1);

        // An unreadable settings file keeps the default (on).
        const unreadable = fakeServer();
        const brokenSettings = createLeadBoard({ sessionId: () => 's1', client: unreadable.client, isLead: async () => true, autoDetect: async () => { throw new Error('EACCES'); } });
        brokenSettings.onTurnStart(['t4']);
        brokenSettings.onAssistantText(ask);
        await brokenSettings.onTurnEnd();
        expect(unreadable.calls.filter(c => c.op === 'post')).toHaveLength(1);

        const off = fakeServer();
        const switchedOff = board(off, { autoDetect: false }).b;
        switchedOff.onTurnStart(['t3']);
        switchedOff.onAssistantText(ask);
        await switchedOff.onTurnEnd();
        expect(off.calls.filter(c => c.op === 'post')).toEqual([]);
    });

    it('resolves the this_turn anchor to the turn prompt and the latest reply text', async () => {
        const server = fakeServer();
        const { b } = board(server);
        b.onUserMessage({ localId: 'teams-message-1', text: 'submitted', sentFrom: 'team' });
        b.onTurnStart(['teams-message-1']);
        b.onAssistantText('Reviewed; merging.');
        const out = await b.post({ kind: 'report', title: 'PR merged', request_id: 'r1' });
        expect(out).toEqual({ id: 'item-1', created: true });
        expect(server.calls[0].body).toMatchObject({ source: 'lead', kind: 'report', anchor: { localId: 'teams-message-1', snippet: 'Reviewed; merging.' }, requestId: 'r1', inferred: false });
        await b.post({ kind: 'todo', title: 'Log in', anchor: { localId: 'explicit' }, request_id: 'r2' });
        expect(server.calls[1].body).toMatchObject({ anchor: { localId: 'explicit' } });
    });

    it('posts request_human as a deduplicating blocked item, and reports "no board" when unsupported', async () => {
        const server = fakeServer();
        const { b } = board(server);
        expect(await b.postBlocked('Scan the QR code', 'desk')).toBe(true);
        expect(await b.postBlocked('Scan the QR code')).toBe(true);
        const [first, second] = server.calls.filter(c => c.op === 'post').map(c => c.body as AttentionItemPost);
        expect(first).toMatchObject({ source: 'agent', kind: 'blocked', title: 'Scan the QR code', links: [{ type: 'panel', ref: 'desk' }] });
        expect(first.key).toBe(second.key);
        expect(first.requestId).not.toBe(second.requestId);

        const old = fakeServer({ supported: false });
        expect(await board(old).b.postBlocked('Scan the QR code')).toBe(false);
    });

    it('decides tool exposure once, after the probe', async () => {
        const server = fakeServer();
        const { b } = board(server);
        expect(b.toolsExposed()).toBe(false); // probe not finished: not frozen yet
        await b.init();
        expect(b.toolsExposed()).toBe(true);
        server.disable();
        expect(b.toolsExposed()).toBe(true);
    });

    it('prefixes each turn with a short digest of open items, leaving out the question this message created', async () => {
        const server = fakeServer();
        const { b } = board(server);
        await b.init();
        b.toolsExposed();
        await b.post({ kind: 'decision', title: 'Ship order', key: 'ship-order', options: [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }], request_id: 'r' });
        b.onUserMessage(owner('m1', 'status?'));
        await tick(); await tick();
        b.onTurnStart(['m1']);
        const out = await b.decorate('status?');
        const [line1, line2, rest] = out.split('\n');
        expect(line1).toMatch(/^\[Briefing board\] 1 open: decision 「Ship order」 key=ship-order \d+[mh]$/);
        expect(line2).toContain('owner_board_resolve');
        expect(rest).toBe('status?');
    });
});

describe('formatBoardDigest', () => {
    it('stays within two lines and folds the overflow', () => {
        const many = Array.from({ length: 30 }, (_, i) => item({ id: `id-${i}`, title: `Item number ${i} with a fairly long title text`, createdAt: 0 }));
        const digest = formatBoardDigest(many, 60_000, { tools: false })!;
        expect(digest.split('\n')).toHaveLength(1);
        expect(digest.length).toBeLessThan(600);
        expect(digest).toMatch(/\+\d+ more$/);
        expect(formatBoardDigest([], 0, { tools: true })).toBeNull();
        expect(formatBoardDigest([item({ key: 'req:owner-q-m1', source: 'owner', kind: 'question' })], 0, { tools: true })).toContain('owner question 「t」 id=i1');
    });
});
