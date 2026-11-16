/**
 * B-940 — another session's message never reaches Claude Code as the user's.
 *
 * Reproduced on 0.2.215 (skills/tmp/vh-team-B940/e2e): Claude Code ran a turn
 * of its own (a background task's notification) while the wrapper's pull was
 * parked; a session message arrived, was pushed at once with
 * `origin: { kind: 'human' }`, and the model read it as
 * "The user sent a new message while you were working: …".
 *
 * Here: such a message is pushed `isSynthetic` with no origin (Claude Code
 * frames it "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]"), and it waits
 * for the end of a turn Claude Code started on its own. The owner's prompts
 * keep `origin: human` and are not held.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = { permissionMode: 'default' };
const result = { type: 'result', subtype: 'success', is_error: false };
const running = { type: 'system', subtype: 'session_state_changed', state: 'running' };
const tick = () => new Promise((r) => setTimeout(r, 20));

type Pulled = { message: string; mode: EnhancedMode; synthetic?: boolean } | null;

function run(nextMessage: () => Promise<Pulled>, extra: Record<string, unknown> = {}) {
    return claudeRemote({
        sessionId: null,
        path: process.cwd(),
        allowedTools: [],
        hookSettingsPath: '/unused-test-settings.json',
        nextMessage,
        onReady: vi.fn(),
        canCallTool: async () => ({ behavior: 'allow' }) as any,
        isAborted: () => false,
        onSessionFound: vi.fn(),
        onMessage: vi.fn(),
        ...extra,
    } as any);
}

/**
 * Turn 1 = the owner's prompt. After its result Claude Code starts a turn of
 * its own (`running`); the second pull resolves only then. Records whether
 * the pulled message reached the input while that turn was still open.
 */
function ownTurnQuery(events: string[], seen: any[], ownTurnStarted: () => void) {
    vi.mocked(query).mockImplementation((args: any) => ({
        setPermissionMode: vi.fn(),
        interrupt: vi.fn(),
        async *[Symbol.asyncIterator]() {
            const input = args.prompt[Symbol.asyncIterator]();
            seen.push((await input.next()).value);
            yield result;
            yield running; // e.g. a background task's notification turn
            ownTurnStarted();
            const pending = input.next();
            let arrived = false;
            void pending.then(() => { arrived = true; });
            await tick();
            events.push(arrived ? 'pushed during own turn' : 'held during own turn');
            yield result; // the own turn ends
            seen.push((await pending).value);
            yield result;
            expect((await input.next()).done).toBe(true);
        },
    } as any));
}

describe('another session\'s message is never the user\'s (B-940)', () => {
    beforeEach(() => vi.mocked(query).mockReset());

    it('waits for the end of a turn Claude Code started itself, then goes in as synthetic', async () => {
        const events: string[] = [];
        const seen: any[] = [];
        let started!: () => void;
        const ownTurn = new Promise<void>((r) => { started = r; });
        ownTurnQuery(events, seen, started);
        let n = 0;
        await run(async () => {
            n += 1;
            if (n === 1) return { message: 'owner prompt', mode };
            if (n === 2) { await ownTurn; return { message: '[Very Happy session message 1 from "A" s1]\nZ please', mode, synthetic: true }; }
            return null;
        });
        expect(events).toEqual(['held during own turn']);
        expect(seen[0]).toMatchObject({ origin: { kind: 'human' }, message: { content: 'owner prompt' } });
        expect(seen[1]).toMatchObject({ isSynthetic: true, message: { content: '[Very Happy session message 1 from "A" s1]\nZ please' } });
        expect(seen[1]).not.toHaveProperty('origin');
    });

    it('leaves the owner\'s prompt exactly as before: human, and not held', async () => {
        const events: string[] = [];
        const seen: any[] = [];
        let started!: () => void;
        const ownTurn = new Promise<void>((r) => { started = r; });
        ownTurnQuery(events, seen, started);
        let n = 0;
        await run(async () => {
            n += 1;
            if (n === 1) return { message: 'owner prompt', mode };
            if (n === 2) { await ownTurn; return { message: 'owner again', mode }; }
            return null;
        });
        expect(events).toEqual(['pushed during own turn']);
        expect(seen[1]).toMatchObject({ origin: { kind: 'human' }, message: { content: 'owner again' } });
        expect(seen[1]).not.toHaveProperty('isSynthetic');
    });

    it('a Query opened by another session\'s message starts it as synthetic', async () => {
        const seen: any[] = [];
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                seen.push((await input.next()).value);
                yield result;
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        let n = 0;
        await run(async () => (++n === 1 ? { message: 'peer text', mode, synthetic: true } : null));
        expect(seen[0]).toMatchObject({ isSynthetic: true, message: { content: 'peer text' } });
        expect(seen[0]).not.toHaveProperty('origin');
    });

    it('a held message the Query never took is handed back to the launcher', async () => {
        const undelivered: any[] = [];
        let started!: () => void;
        const ownTurn = new Promise<void>((r) => { started = r; });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                await input.next();
                yield result;
                yield running;
                started();
                await tick();
                // The Query ends (crash / teardown) inside its own turn.
            },
        } as any));
        let n = 0;
        await run(async () => {
            n += 1;
            if (n === 1) return { message: 'owner prompt', mode };
            if (n === 2) { await ownTurn; return { message: 'peer text', mode, synthetic: true }; }
            return null;
        }, { onUndeliveredMessage: (m: unknown) => undelivered.push(m) });
        expect(undelivered).toEqual([expect.objectContaining({ message: 'peer text', synthetic: true })]);
    });

    it('an edit-conflict notice steered into the turn goes in as synthetic; the owner\'s steer stays human', async () => {
        const seen: any[] = [];
        let steer!: (message: string, mode: EnhancedMode, localKey?: string, synthetic?: boolean) => void;
        let ready!: () => void;
        const readyP = new Promise<void>((r) => { ready = r; });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                seen.push((await input.next()).value);
                await readyP;
                steer('[Very Happy edit conflict 1; file /a.ts; peer "A" s1]\nheads up', mode, undefined, true);
                steer('owner steer', mode);
                seen.push((await input.next()).value);
                seen.push((await input.next()).value);
                yield result;
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        let n = 0;
        await run(async () => (++n === 1 ? { message: 'owner prompt', mode } : null), {
            onQueryReady: (q: { steer: typeof steer }) => { steer = q.steer; ready(); },
        });
        expect(seen[1]).toMatchObject({ isSynthetic: true, priority: 'now' });
        expect(seen[1]).not.toHaveProperty('origin');
        expect(seen[2]).toMatchObject({ origin: { kind: 'human' }, priority: 'now', message: { content: 'owner steer' } });
    });

    it('B-940b: a held message is reported undelivered (by its localIds) until it is pushed — an exiting process hands it on', async () => {
        const probes: string[][] = [];
        let probe!: () => string[];
        let started!: () => void;
        const ownTurn = new Promise<void>((r) => { started = r; });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                await input.next();
                probes.push(probe());
                yield result;
                yield running;
                started();
                await tick();
                probes.push(probe()); // held behind the own turn
                yield result;
                await input.next();
                probes.push(probe()); // pushed
                yield result;
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        let n = 0;
        await run(async () => {
            n += 1;
            if (n === 1) return { message: 'owner prompt', mode, sourceIds: ['o1'] } as any;
            if (n === 2) { await ownTurn; return { message: 'peer text', mode, synthetic: true, uuid: 'p1', sourceIds: ['p1'] } as any; }
            return null;
        }, { onQueryReady: (q: { undeliveredSourceIds: () => string[] }) => { probe = q.undeliveredSourceIds; } });
        expect(probes).toEqual([[], ['p1'], []]);
    });

    it('B-940b (QA-T P3): an owner message waiting at the own turn\'s end runs before the held session message', async () => {
        const seen: any[] = [];
        let started!: () => void;
        const ownTurn = new Promise<void>((r) => { started = r; });
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() {
                const input = args.prompt[Symbol.asyncIterator]();
                seen.push((await input.next()).value);
                yield result;
                yield running;
                started();
                await tick();
                yield result; // own turn ends: the owner's queued message goes first
                seen.push((await input.next()).value);
                yield result;
                seen.push((await input.next()).value);
                yield result;
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        let n = 0;
        let ownerQueued = false;
        await run(async () => {
            n += 1;
            if (n === 1) return { message: 'owner prompt', mode };
            if (n === 2) { await ownTurn; ownerQueued = true; return { message: 'peer text', mode, synthetic: true }; }
            if (n === 3) { ownerQueued = false; return { message: 'owner later', mode }; }
            return null;
        }, { ownerWaiting: () => ownerQueued });
        expect(seen.map((m) => m.message.content)).toEqual(['owner prompt', 'owner later', 'peer text']);
        expect(seen[1]).toMatchObject({ origin: { kind: 'human' } });
        expect(seen[2]).toMatchObject({ isSynthetic: true });
    });
});
