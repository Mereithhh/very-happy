import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-312 pins the two halves the Owner actually asked for: the 未读 dot is RED
 * (it was --text, the row's own ink, and went unnoticed), and it survives a
 * reload (the set was memory-only).
 */
describe('sidebar unread dot (B-312)', () => {
    const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8');
    const storage = readFileSync(new URL('../../sync/storage.ts', import.meta.url), 'utf8');

    it('paints the unread badge with --danger, not --text, and keeps a halo', () => {
        const rule = css.slice(css.indexOf('.sb-row-signal--unread'));
        const body = rule.slice(0, rule.indexOf('}'));
        expect(body).toContain('background: var(--danger)');
        expect(body).toContain('var(--danger-dim)');
        expect(body).not.toContain('var(--text)');
    });

    it('keeps attention (waiting on you) on accent so the two levels stay distinct', () => {
        const rule = css.slice(css.indexOf('.sb-row-signal--attention'));
        expect(rule.slice(0, rule.indexOf('}'))).toContain('background: var(--accent)');
    });

    it('uses no raw color literal for either signal dot', () => {
        const block = css.slice(css.indexOf('.sb-row-signal {'), css.indexOf('.sb-row.is-selected .sb-row-sub'));
        expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(block).not.toMatch(/\brgba?\(/i);
    });

    it('seeds the unread set from the mirror on boot', () => {
        expect(storage).toContain('new Set<string>(loadUnreadSessionIds())');
    });

    it('persists every path that changes the set — an unpersisted clear resurrects the dot', () => {
        // opening the session is the ONLY clear path today (markSessionRead has
        // no callers), so this one is load-bearing
        expect(storage).toMatch(
            /const next = sessionId && state\.unreadSessionIds\.has\(sessionId\)[\s\S]{0,400}?saveUnreadSessionIds\(next\)/,
        );
        // the producer: agent went running -> idle while the user looked elsewhere
        expect(storage).toMatch(
            /if \(unreadSessionIds !== state\.unreadSessionIds\) saveUnreadSessionIds\(unreadSessionIds\)/,
        );
        // explicit marks and session deletion
        expect(storage).toMatch(/next\.delete\(sessionId\);\s*\n\s*saveUnreadSessionIds\(next\)/);
        expect(storage).toMatch(/next\.add\(sessionId\);\s*\n\s*saveUnreadSessionIds\(next\)/);
        expect(storage).toMatch(
            /unreadSessionIds\.delete\(sessionId\);\s*\n\s*saveUnreadSessionIds\(unreadSessionIds\)/,
        );
    });
});

/**
 * B-330: the same dot for web terminals. The store side is behaviour-tested in
 * sync/terminalUnread.test.ts; what needs pinning here is the wiring, because
 * a terminal row that never consults the terminal set renders nothing and the
 * feature is invisible again — exactly how it was reported missing.
 */
describe('sidebar unread dot — terminals (B-330)', () => {
    const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../terminal/WebTerminalRoute.tsx', import.meta.url), 'utf8');

    it('a terminal row reads the terminal set, keyed by terminalId not the row key', () => {
        // Row.key is `t:<id>` while the store holds bare terminal ids; matching
        // the two up is the whole bug surface here.
        expect(sidebar).toMatch(
            /r\.kind === 'terminal' &&[\s\S]{0,120}?unreadTerminalIds\.has\(r\.terminalId\)/,
        );
        expect(sidebar).toContain("useTerminalAgentStates((s) => s.unread)");
    });

    it('opening a terminal registers it as viewed AND clears its dot', () => {
        // Only marking it read would let a run finishing under the user's eyes
        // immediately re-mark it.
        expect(route).toMatch(/store\.setViewingTerminal\(tid\);\s*\n\s*store\.markTerminalRead\(tid\)/);
    });
});
