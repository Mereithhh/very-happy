// @vitest-environment happy-dom
/**
 * B-615 regression: in WebKit (Safari, iOS, the PWA) a reader scrolled up
 * into the reply was thrown 1222–2524px up when the persisted reply landed
 * (Chromium: 0px). Probe: /dev/chat-scroll, reader 500px above the live end;
 * evidence in the PR.
 *
 * Mechanism (measured on the real page in WebKit): when a commit both adds
 * content and REMOVES a node with boxes, WebKit clamps the transcript's
 * scrollTop against the old layout minus the removed node — before the added
 * content counts. Two commits did that while the reader was in the reply:
 *   1. landing: the reply is added to the live turn and the draft that showed
 *      the same text is removed (LiveStreamView);
 *   2. turn end: the answer moves out of the live activity row into a row of
 *      its own — the row the reader is looking at is removed.
 * Hiding a node (display: none) in that commit does not clamp, and removing
 * an already-hidden node later does not either; scrollTop writes are no fix
 * (WebKit ignores them during momentum, B-603).
 *
 * Rules pinned here:
 *   - a draft block that leaves stays in the DOM, hidden, for one frame
 *     (draftRetire.ts) — the same DOM node, so nothing is torn down;
 *   - the live turn's activity row exists while a draft is on screen, and a
 *     turn that stops being the live one under a detached reader (liveness
 *     dropped, or the next turn started) keeps that shape — by turn, later
 *     turns do not release it — until the reader follows again and the scroll
 *     settles (chatTurns `liveDraft` / `keepTurnsOpen`, turnHold.ts);
 *   - a held answer renders as its own row would (actions, meta, suggestions)
 *     and its activity row does not fold while it holds it.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ StatusDot: () => null }));
vi.mock('./Markdown', () => ({
    Markdown: ({ text }: { text: string }) => <p>{text}</p>,
    NoPathLinks: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./ActivityMessages', () => ({ ActivityMessages: () => <div className="ta-steps" /> }));
vi.mock('./useElapsed', () => ({ useElapsedSeconds: () => 0 }));
vi.mock('@/sync/liveStreamStore', () => ({ useLiveStream: () => ({ blocks: [], sweepAt: null }) }));
vi.mock('@/sync/storage', () => ({ useSession: () => null }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => false }));
vi.mock('@/sync/agentLiveness', () => ({ isAgentWorkLive: () => false }));

import { LiveStreamBlocks } from './LiveStreamView';
import { draftRenderList } from './draftRetire';
import { buildChatRows, newestTurnOpenerId } from './chatTurns';
import { NO_HELD_TURNS, holdEndedTurn } from './turnHold';
import { TurnActivityView } from './TurnActivityView';
import { ReaderFollowContext, createReaderFollow, type ReaderFollowSource } from './readerFollow';
import type { LiveStreamBlock } from '@/sync/liveStream';
import type { Message } from '@/sync/typesMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block = (key: string, text: string): LiveStreamBlock => ({ key, kind: 'text', text, done: false, doneAt: null });

describe('B-615 draftRenderList: a block that left is kept, hidden, in place', () => {
    it('keeps a claimed block in its position, flagged hidden', () => {
        const a = block('m:0', 'thinking'); const b = block('m:1', 'answer');
        expect(draftRenderList([a, b], [b])).toEqual([{ block: a, hidden: true }, { block: b, hidden: false }]);
        expect(draftRenderList([a, b], [])).toEqual([{ block: a, hidden: true }, { block: b, hidden: true }]);
    });

    it('nothing hidden while blocks only grow or arrive; the next block\'s text is used', () => {
        const a = block('m:0', 'one'); const grown = block('m:0', 'one two'); const c = block('m:1', 'three');
        expect(draftRenderList([a], [grown, c])).toEqual([{ block: grown, hidden: false }, { block: c, hidden: false }]);
        expect(draftRenderList([], [])).toEqual([]);
    });
});

describe('B-615 LiveStreamBlocks: the claim commit hides the draft, the next frame removes it', () => {
    let host: HTMLDivElement;
    let root: Root;
    let frames: FrameRequestCallback[];
    beforeEach(() => {
        frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });
    const render = (blocks: LiveStreamBlock[]) => act(() => root.render(<LiveStreamBlocks blocks={blocks} />));
    const nextFrame = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });

    it('the whole draft claimed: same nodes stay, hidden; gone after one frame', () => {
        render([block('m:0', 'the answer')]);
        const slot = host.querySelector('.ls');
        const msg = host.querySelector('.ls > .msg');
        expect(msg?.textContent).toContain('the answer');

        render([]);
        expect(host.querySelector('.ls')).toBe(slot);
        expect(host.querySelector('.ls > .msg')).toBe(msg);
        expect(slot?.hasAttribute('hidden')).toBe(true);
        expect(msg?.hasAttribute('hidden')).toBe(true);

        nextFrame();
        expect(host.querySelector('.ls')).toBeNull();
    });

    it('one of two blocks claimed: it hides in place, the other keeps streaming', () => {
        render([block('m:0', 'thinking'), block('m:1', 'answer')]);
        const [first, second] = host.querySelectorAll('.ls > .msg');
        render([block('m:1', 'answer grows')]);
        const now = host.querySelectorAll('.ls > .msg');
        expect(now[0]).toBe(first);
        expect(now[1]).toBe(second);
        expect(first.hasAttribute('hidden')).toBe(true);
        expect(second.hasAttribute('hidden')).toBe(false);
        expect(second.textContent).toContain('answer grows');
        expect(host.querySelector('.ls')?.hasAttribute('hidden')).toBe(false);

        nextFrame();
        expect(host.querySelectorAll('.ls > .msg')).toHaveLength(1);
        expect(host.querySelector('.ls > .msg')).toBe(second);
    });

    it('the hidden rule outranks `.ls` / `.msg` display', () => {
        const css = readFileSync(resolve(__dirname, 'livestream.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).toMatch(/\.ls\[hidden\],\s*\.ls > \[hidden\]\s*\{\s*display:\s*none;/);
    });
});

const user = (id: string, createdAt: number): Message => ({ kind: 'user-text', id, localId: null, createdAt, text: id });
const reply = (id: string, createdAt: number, text = id): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text, totalDurationMs: 4000 });
const tool = (id: string, createdAt: number): Message => ({
    kind: 'tool-call', id, localId: null, createdAt, children: [],
    tool: { name: id, state: 'completed', input: {}, createdAt, startedAt: createdAt, completedAt: createdAt + 1, description: null },
} as Message);
const keys = (messages: Message[], live: boolean, options: Parameters<typeof buildChatRows>[2] = {}) =>
    buildChatRows(messages, live, options).map((row) => row.key);
const held = (...ids: string[]) => new Set(ids);

describe('B-615 row keys do not change while the reader may be in the reply', () => {
    const history = [user('u0', 1), reply('a0', 2)];
    const asked = [...history, user('u1', 3)];
    const landed = [...asked, reply('a1', 4)];

    it('landing: the live activity row already exists while the draft shows', () => {
        expect(keys(asked, true, { liveDraft: true })).toEqual(keys(landed, true));
        // without it the row (and its header above the answer) appears at landing
        expect(keys(asked, true)).not.toEqual(keys(landed, true));
    });

    it('turn end under a detached reader: the answer stays inside the same row', () => {
        const live = buildChatRows(landed, true);
        const rows = buildChatRows(landed, false, { keepTurnsOpen: held('u1') });
        expect(rows.map((row) => row.key)).toEqual(live.map((row) => row.key));
        expect(rows.at(-1)).toMatchObject({ type: 'activity', live: false, durationSeconds: 4, messages: [{ id: 'a1' }], answer: { id: 'a1' } });
        // released: the answer moves to its own row — the remount the hold defers
        expect(keys(landed, false)).toEqual(['u0', 'a0', 'u1', 'a1']);
    });

    it('a held turn stays held while the next turn starts, lands and ends', () => {
        const opts = { keepTurnsOpen: held('u1') };
        const heldRow = (rows: ReturnType<typeof buildChatRows>) => rows.find((row) => row.key === 'activity-u1');
        const started = [...landed, user('u2', 5)];
        const answered = [...started, reply('a2', 6)];
        for (const [messages, live] of [[started, true], [answered, true], [answered, false]] as const) {
            const rows = buildChatRows([...messages], live, opts);
            expect(rows.slice(0, 4).map((row) => row.key)).toEqual(['u0', 'a0', 'u1', 'activity-u1']);
            expect(heldRow(rows)).toMatchObject({ type: 'activity', live: false, messages: [{ id: 'a1' }], answer: { id: 'a1' } });
        }
        // the newer turn finishes normally unless it is held too
        expect(keys(answered, false, opts).slice(4)).toEqual(['u2', 'a2']);
        expect(keys(answered, false, { keepTurnsOpen: held('u1', 'u2') }).slice(4)).toEqual(['u2', 'activity-u2']);
        expect(keys(answered, false).slice(2)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    it('older turns keep their finished shape', () => {
        const rows = buildChatRows(landed, false, { keepTurnsOpen: held('u1') });
        expect(rows.slice(0, 2).map((row) => row.key)).toEqual(['u0', 'a0']);
    });
});

describe('B-615 a held answer renders as its own answer row would', () => {
    const asked = [user('u0', 1), tool('read', 2), user('u1', 3)];

    it('actions always; meta while it is the newest answer; suggestions until something user-side follows', () => {
        const text = 'Done.\n<options><option>Ship it</option></options>';
        const landed = [...asked, reply('a1', 4, text)];
        const [answer] = buildChatRows(landed, false, { keepTurnsOpen: held('u1') }).flatMap((row) => (row.type === 'activity' && row.answer ? [row.answer] : []));
        const own = buildChatRows(landed, false).find((row) => row.type === 'message' && row.message.id === 'a1');
        expect(answer).toEqual({ id: 'a1', showMeta: true, showActions: true, optionsActive: true });
        expect(own).toMatchObject({ showMeta: true, optionsActive: true });
        expect(own).not.toHaveProperty('showActions', false);

        const next = [...landed, user('u2', 5), reply('a2', 6)];
        const [later] = buildChatRows(next, false, { keepTurnsOpen: held('u1') }).flatMap((row) => (row.type === 'activity' && row.answer ? [row.answer] : []));
        expect(later).toEqual({ id: 'a1', showMeta: false, showActions: true, optionsActive: false });
    });

    it('an answer the agent followed with a tool call has no actions — as its own row', () => {
        const landed = [...asked, reply('a1', 4), tool('late', 5)];
        const [answer] = buildChatRows(landed, false, { keepTurnsOpen: held('u1') }).flatMap((row) => (row.type === 'activity' && row.answer ? [row.answer] : []));
        const own = buildChatRows(landed, false).find((row) => row.type === 'message' && row.message.id === 'a1');
        expect(own).toMatchObject({ showActions: false });
        expect(answer).toMatchObject({ id: 'a1', showActions: false });
    });
});

describe('B-615 newestTurnOpenerId / holdEndedTurn', () => {
    it('names the turn buildChatRows treats as live', () => {
        const messages = [user('u0', 1), reply('a0', 2), user('u1', 3), tool('read', 4)];
        expect(newestTurnOpenerId(messages)).toBe('u1');
        const live = buildChatRows(messages, true).find((row) => row.type === 'activity' && row.live);
        expect(live?.key).toBe(`activity-${newestTurnOpenerId(messages)}`);
        expect(newestTurnOpenerId([reply('a', 1)])).toBeNull();
        expect(newestTurnOpenerId([])).toBeNull();
    });

    it('holds the turn that stopped being live — liveness dropped or the next turn started — for a detached reader only', () => {
        expect([...holdEndedTurn(NO_HELD_TURNS, 'u1', null, false)]).toEqual(['u1']);
        expect([...holdEndedTurn(NO_HELD_TURNS, 'u1', 'u2', false)]).toEqual(['u1']);
        expect([...holdEndedTurn(held('u1'), 'u2', null, false)]).toEqual(['u1', 'u2']);
        expect(holdEndedTurn(NO_HELD_TURNS, 'u1', null, true)).toBe(NO_HELD_TURNS);
        expect(holdEndedTurn(NO_HELD_TURNS, null, 'u2', false)).toBe(NO_HELD_TURNS);
        expect(holdEndedTurn(NO_HELD_TURNS, 'u1', 'u1', false)).toBe(NO_HELD_TURNS);
        const once = held('u1');
        expect(holdEndedTurn(once, 'u1', null, false)).toBe(once);
    });
});

describe('B-615 TurnActivityView with a held answer', () => {
    let host: HTMLDivElement;
    let root: Root;
    let reader: ReaderFollowSource;
    let panelTop = -1200;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    beforeEach(() => {
        reader = createReaderFollow(false);
        panelTop = -1200;
        HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
            const box = rect.call(this);
            if (this.classList.contains('cl-scroll')) return { ...box.toJSON(), top: 0, bottom: 600 } as DOMRect;
            if (this.classList.contains('ta-detail')) return { ...box.toJSON(), top: panelTop, bottom: panelTop + 3000 } as DOMRect;
            return box;
        };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        HTMLElement.prototype.getBoundingClientRect = rect;
    });
    const answer = { id: 'a1', showMeta: true, showActions: true, optionsActive: false };
    const messages = [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'answer' }] as unknown as Message[];
    const render = (live: boolean, held: boolean, items = messages) => act(() => root.render(
        <ReaderFollowContext.Provider value={reader}>
            <div className="cl-scroll">
                <TurnActivityView messages={items} live={live} sessionId="s" answer={held ? answer : undefined} />
            </div>
        </ReaderFollowContext.Provider>,
    ));
    const expanded = () => host.querySelector('.ta-detail') !== null;

    it('re-follow while held: stays open; folds when the answer leaves', () => {
        render(true, false);
        render(false, true);
        expect(expanded()).toBe(true);
        act(() => reader.set(true));
        expect(expanded()).toBe(true);
        render(false, false);
        expect(expanded()).toBe(false);
    });

    it('ends entirely below the reader: still not folded while it holds the answer', () => {
        render(true, false);
        panelTop = 900;
        render(false, true);
        expect(expanded()).toBe(true);
    });

    it('without a held answer the B-607 rule is unchanged (below the reader → folds)', () => {
        render(true, false);
        panelTop = 900;
        render(false, false);
        expect(expanded()).toBe(false);
    });

    it('a live row with only a draft below it shows no 「0s」 duration', () => {
        render(true, false, []);
        expect(host.querySelector('.ta-title')?.textContent).toBe('session.chat.liveProcessing');
        render(true, false);
        expect(host.querySelector('.ta-title')?.textContent).toBe('session.chat.activityElapsed');
    });
});

describe('B-615 ChatList wiring', () => {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const chatList = strip(readFileSync(resolve(__dirname, 'ChatList.tsx'), 'utf8'));
    const liveView = strip(readFileSync(resolve(__dirname, 'LiveStreamView.tsx'), 'utf8'));

    it('tracks the live turn by its opener and holds the one that stopped being live, for a detached reader', () => {
        expect(chatList).toContain('(sessionLive ? newestTurnOpenerId(shownChronological) : null)');
        expect(chatList).toContain('const following = atBottomRef.current;');
        expect(chatList).toContain('setHeldTurns((held) => holdEndedTurn(held, liveTurnSeen.turn, liveTurn, following));');
    });
    it('releases them only once following and settled, then re-pins to the bottom', () => {
        expect(chatList).toMatch(/if \(wait > 0\) \{\s*timer = setTimeout\(check, wait\);\s*return;\s*\}\s*timer = null;\s*if \(atBottomRef\.current\) setHeldTurns\(NO_HELD_TURNS\);/);
        expect(chatList).toContain('if (released && atBottomRef.current) scrollToBottom(false);');
    });
    it('feeds both options to the rows and the held answer to the activity row', () => {
        expect(chatList).toContain('keepTurnsOpen: heldTurns, liveDraft }');
        expect(chatList).toContain('answer={row.answer}');
    });
    it('an empty live panel + the row gap equals the panel padding the answer lands under', () => {
        const css = strip(readFileSync(resolve(__dirname, 'turnactivity.css'), 'utf8'));
        const gap = strip(readFileSync(resolve(__dirname, 'chatlist.css'), 'utf8')).match(/\.cl-inner \{[^}]*gap: calc\(var\(--chat-space\) \* (\d+)\)/)?.[1];
        const pad = css.match(/\.ta-detail \{[^}]*padding-top: calc\(var\(--chat-space\) \* (\d+)\)/)?.[1];
        const empty = css.match(/\.ta-detail:empty \{\s*padding-top: var\(--chat-space\);/);
        expect(gap).toBe('3');
        expect(pad).toBe('4');
        expect(empty).not.toBeNull();
    });
    it('a draft dropped by liveness also retires hidden-first (rendered empty, not unmounted)', () => {
        expect(liveView).toContain('if (!live && stream.sweepAt === null) return <LiveStreamBlocks blocks={NO_BLOCKS} />;');
    });
});
