import { describe, expect, it } from 'vitest';
import { applyFileMention, fileMentionDismissKey, fileMentionQuery, fileMentionText } from './fileMention';

/** `|` marks the caret. */
function at(marked: string) {
    const caret = marked.indexOf('|');
    return { text: marked.replace('|', ''), caret };
}
const q = (marked: string) => { const { text, caret } = at(marked); return fileMentionQuery(text, caret); };

describe('B-035 fileMentionQuery: the token under the caret starts with @', () => {
    it('triggers at the start, mid-message and on a new line', () => {
        expect(q('@|')).toEqual({ start: 0, end: 1, query: '' });
        expect(q('@src/ma|')).toEqual({ start: 0, end: 7, query: 'src/ma' });
        expect(q('look at @Age|')).toEqual({ start: 8, end: 12, query: 'Age' });
        expect(q('first\n@rea|')).toEqual({ start: 6, end: 10, query: 'rea' });
    });

    it('the whole token counts when the caret is inside it', () => {
        expect(q('see @sr|c/main.ts now')).toEqual({ start: 4, end: 16, query: 'src/main.ts' });
    });

    it('does not trigger for e-mails, a bare word, after a space, or with the caret before the @', () => {
        expect(q('mail a@b.co|')).toBeNull();
        expect(q('plain|')).toBeNull();
        expect(q('@src |')).toBeNull();
        expect(q('|@src')).toBeNull();
        expect(q('@a@b|')).toBeNull();
    });

    it('strips the quotes of a quoted token (a quoted path WITH spaces is not re-completed)', () => {
        expect(q('@"src/ma|"')).toEqual({ start: 0, end: 9, query: 'src/ma' });
        expect(q('@"dir x/c.t|"')).toBeNull();
    });
});

describe('B-035 applyFileMention', () => {
    it('replaces the token, keeps @, adds one space and puts the caret after it', () => {
        const { text, caret } = at('look at @Age|');
        const out = applyFileMention(text, fileMentionQuery(text, caret)!, 'src/screens/session/AgentInput.tsx');
        expect(out.text).toBe('look at @src/screens/session/AgentInput.tsx ');
        expect(out.caret).toBe(out.text.length);
    });

    it('keeps the rest of the message and does not double an existing space', () => {
        const { text, caret } = at('see @sr|c now');
        const out = applyFileMention(text, fileMentionQuery(text, caret)!, 'src/main.ts');
        expect(out.text).toBe('see @src/main.ts now');
        expect(out.text.slice(0, out.caret)).toBe('see @src/main.ts ');
    });

    it('quotes a path with whitespace the way Claude Code expands it', () => {
        expect(fileMentionText('dir x/c.txt')).toBe('@"dir x/c.txt"');
        expect(fileMentionText('a.txt')).toBe('@a.txt');
    });

    it('dismiss key changes when the token changes', () => {
        const a = at('@ab|'), b = at('@abc|');
        expect(fileMentionDismissKey(a.text, fileMentionQuery(a.text, a.caret)!)).not.toBe(fileMentionDismissKey(b.text, fileMentionQuery(b.text, b.caret)!));
    });
});
