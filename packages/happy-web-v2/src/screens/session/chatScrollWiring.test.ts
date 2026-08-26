import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./chatlist.css', import.meta.url), 'utf8');

describe('session-scoped transcript scrolling', () => {
    it('remounts the transcript by session and resets cached-session state before paint', () => {
        expect(detail).toContain('<ChatList key={id} sessionId={id}');
        expect(chat).toContain('useLayoutEffect(() => {\n        if (!isLoaded) return;');
        expect(chat).toContain('atBottomRef.current = true;');
        expect(chat).toContain('}, [sessionId, isLoaded]);');
    });

    it('uses native vertical touch scrolling without browser scroll anchoring fighting bottom-follow', () => {
        expect(css).toMatch(/\.cl-scroll \{[\s\S]*touch-action: pan-y;/);
        expect(css).toMatch(/\.cl-scroll \{[\s\S]*overflow-anchor: none;/);
    });
});
