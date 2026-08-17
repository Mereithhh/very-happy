/**
 * Wiring guards for the v2 terminal channel (B-121, spec
 * 2026-08-terminal-channel-v2 §D2 / §D3 / §D4).
 *
 * `termAssembly.test.ts` proves the state machine. What it CANNOT prove is that
 * the screen component is plugged into it correctly — and the spec's two
 * self-destruct points are exactly wiring, not logic:
 *   • an applied chunk that never reaches `assembly.noteLiveChunk` is erased by
 *     the rebuild's reset and the screen forks from reality permanently;
 *   • a live chunk routed raw around `sync.liveChunk` during a rebuild freezes
 *     lastSeq → the next chunk reads as a gap → catch-up resets → the deep
 *     history that was just assembled is wiped.
 * The screen has no test harness (no jsdom in this project, and the effect
 * needs a socket + xterm + a machine), so these are source-level assertions —
 * the same instrument termInputHost.test.ts uses for its "there is exactly one
 * input element" invariants. They are deliberately narrow: each one names a
 * behavior that has a documented failure mode if it silently disappears.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const screen = read('./WebTerminalScreen.tsx');
const css = read('./terminal.css');
const ops = read('../../sync/ops.ts');

describe('capability declaration + per-mount latch (§D3)', () => {
    it('every open declares streamMode:lines — mount-time AND catch-up', () => {
        // The daemon builds its response shape from the request's capability,
        // so a catch-up that forgot the field would get the v1 snapshot shape
        // back mid-session and trip the latch into a pointless remount.
        expect((screen.match(/streamMode: 'lines',/g) ?? []).length).toBe(2);
    });

    it('an absent streamMode falls back to attach, never to lines', () => {
        expect((screen.match(/res\.streamMode \?\? 'attach'/g) ?? []).length).toBe(2);
        expect(ops.includes('streamMode: result.streamMode')).toBe(true);
    });

    it('a streamMode flip remounts instead of hot-switching tracks', () => {
        expect(screen.includes('setStreamRemount((n) => n + 1)')).toBe(true);
        expect(/\}, \[machineId, tid, inputOwnership, streamRemount\]\);/.test(screen)).toBe(true);
    });
});

describe('assembly wiring (§D1 传输与重建)', () => {
    it('applied chunks reach the assembly — live AND replay', () => {
        // Both branches of applyLiveChunk plus the replay loop must write via
        // liveWrite (which takes the copy); gatedWrite alone means "not copied".
        expect(screen.includes('liveWrite(b64ToBytes(plain))')).toBe(true); // live, encrypted
        expect(screen.includes('liveWrite(b64ToBytes(e.data))')).toBe(true); // live, plaintext
        expect(screen.includes('if (bytes && !disposed) liveWrite(bytes)')).toBe(true); // replay
        expect(screen.includes('flushAssembly(assembly.noteLiveChunk(bytes))')).toBe(true);
    });

    it('a gap aborts the assembly and still hands its deferred chunks back', () => {
        expect(screen.includes("flushAssembly(assembly.abort('gap'))")).toBe(true);
    });

    it('the assembly starts at the ASSIGN, not when the restore is written', () => {
        const snapshotBranch = screen.slice(
            screen.indexOf("if (res.mode === 'snapshot')"),
            screen.indexOf('// Replay: apply only chunks'),
        );
        const assign = snapshotBranch.indexOf('sync.snapshotApplied(');
        const start = snapshotBranch.indexOf('startAssembly(res);');
        expect(assign).toBeGreaterThan(-1);
        expect(start).toBeGreaterThan(assign);
        // …and before the returned closure, i.e. synchronously in the same tick.
        expect(start).toBeLessThan(snapshotBranch.indexOf('return async () =>'));
    });

    it('the rebuild is reset → pages → copies → deferred, in one slot', () => {
        const body = screen.slice(screen.indexOf('const runRebuild = ()'));
        const order = ['term.reset();', 'plan.pages', 'plan.copies', 'assembly.finishRebuild()'];
        let at = -1;
        for (const needle of order) {
            const next = body.indexOf(needle);
            expect(next).toBeGreaterThan(at);
            at = next;
        }
    });

    it('the quiet gate is re-evaluated inside the writing slot', () => {
        expect(screen.includes('assembly.tryRebuild(!writeHold.isHolding() && atBottom())')).toBe(true);
        // beginSnapshotRestore is for reconnects — using it here would drop the
        // user's selection hold for a background beautification (R3 M-R3-1).
        const body = screen.slice(screen.indexOf('const runRebuild = ()'));
        expect(body.includes('beginSnapshotRestore')).toBe(false);
    });

    it('history paging keeps its concurrency / timeout / retry budget', () => {
        expect(screen.includes('HISTORY_PAGE_CONCURRENCY = 2')).toBe(true);
        expect(screen.includes('HISTORY_PAGE_TIMEOUT_MS = 15_000')).toBe(true);
        expect(screen.includes('HISTORY_PAGE_ATTEMPTS = 2')).toBe(true);
        // snapshot-expired → give up on this assembly, retry the open ONCE.
        expect(screen.includes("flushAssembly(assembly.abort('snapshot-expired'))")).toBe(true);
        expect(screen.includes('openRetriedAfterExpiry')).toBe(true);
        expect(ops.includes("r.error === 'snapshot-expired'")).toBe(true);
    });
});

describe('two-track scrolling (§D2) and what must NOT be retired (§D4)', () => {
    it('the alt-buffer track keeps every v1 mechanism', () => {
        // terminal-scroll RPC, wheel batching, failure backoff, touch→wheel.
        expect(ops.includes("'terminal-scroll'")).toBe(true);
        expect(screen.includes('machineScrollTerminal(')).toBe(true);
        expect(screen.includes('attachCustomWheelEventHandler')).toBe(true);
        expect(screen.includes("new WheelEvent('wheel'")).toBe(true);
        expect(screen.includes('SCROLL_RPC_MAX_FAILS')).toBe(true);
    });

    it('the normal buffer under lines mode takes neither touch nor wheel', () => {
        expect(screen.includes("if (linesActive && term.buffer.active.type !== 'alternate') return;")).toBe(true);
        expect(screen.includes("if (term.buffer.active.type !== 'alternate') return true;")).toBe(true);
    });

    it('touch-action follows the buffer, in both halves', () => {
        expect(screen.includes('term.buffer.onBufferChange(')).toBe(true);
        expect(screen.includes("term-host--lines")).toBe(true);
        expect(screen.includes("term-host--alt")).toBe(true);
        expect(/\.term-host--lines \{\s*touch-action: pan-y;/.test(css)).toBe(true);
        expect(/\.term-host--lines\.term-host--alt \{\s*touch-action: none;/.test(css)).toBe(true);
    });

    it('the mouse-mode filter stays installed (alt track depends on it)', () => {
        expect(read('./renderer/xtermRenderer.ts').includes('installMouseModeFilter(term)')).toBe(true);
    });

    it('the blank-screen belt is retired on the lines track only', () => {
        expect(screen.includes('if (linesActive) return; // belt retired')).toBe(true);
        expect(screen.includes('isScreenBlank')).toBe(true); // still there for attach
    });
});

describe('paste routing (§D1b 粘贴专路)', () => {
    it('lines mode pastes through the daemon, attach mode locally', () => {
        expect(screen.includes('await machineTerminalPaste(machineId, terminalId')).toBe(true);
        expect(screen.includes('if (!linesActive || !terminalId) {\n        term.paste(text);')).toBe(true);
    });

    it('clipboard TEXT is consumed on the host capture listener in lines mode', () => {
        const onPaste = screen.slice(screen.indexOf('const onPaste = (e: ClipboardEvent)'));
        expect(onPaste.includes('if (!linesActive) return;')).toBe(true);
        expect(onPaste.includes('e.stopImmediatePropagation();')).toBe(true);
    });

    it('run-presets await the paste before sending \\r', () => {
        // Two executors let the Enter land first and run an empty line.
        expect(screen.includes("void runCommand(paste).then(() => sendInputRef.current?.('\\r'));")).toBe(true);
    });
});
