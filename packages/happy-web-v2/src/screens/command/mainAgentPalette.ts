/**
 * B-916a: ⌘K → main agent. The palette offers 「问主 agent：<查询>」 for any
 * non-empty query, and ⌘↩ / Ctrl+↩ sends the query there from whichever row is
 * highlighted (plain ↩ keeps running the highlighted row).
 */

export const MAIN_AGENT_ASK_KEY = 'create:main-agent';

export function mainAgentAskTrigger(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, query: string): boolean {
    return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && query.trim() !== '';
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '');
/** Drawer toggle hint (⌘⇧A would be the browser's tab search). */
export const MAIN_AGENT_CHORD_HINT = IS_MAC ? '⌘⇧E' : 'Ctrl+Shift+E';

/** ⌘⇧E / Ctrl+Shift+E by physical key, so non-Latin layouts work too. */
export function isMainAgentChord(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
    return e.code === 'KeyE' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;
}
