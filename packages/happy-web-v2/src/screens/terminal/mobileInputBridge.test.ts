/**
 * Unit tests for the mobile input bridge's diff engine — the pure core that
 * mirrors hidden-textarea edits to the pty. Each scenario block names the
 * real-world soft-keyboard behavior it models (see mobileInputBridge.ts header
 * for the mechanism write-up).
 */
import { describe, it, expect } from 'vitest';
import { diffTextValue, toPtyText } from './mobileInputBridge';

describe('diffTextValue', () => {
    it('no change → nothing', () => {
        expect(diffTextValue('hello', 'hello')).toEqual({ deletes: 0, insert: '' });
        expect(diffTextValue('', '')).toEqual({ deletes: 0, insert: '' });
    });

    it('plain typing appends (iOS insertText per letter)', () => {
        expect(diffTextValue('', 'h')).toEqual({ deletes: 0, insert: 'h' });
        expect(diffTextValue('hell', 'hello')).toEqual({ deletes: 0, insert: 'o' });
    });

    it('backspace removes one char (deleteContentBackward)', () => {
        expect(diffTextValue('hello', 'hell')).toEqual({ deletes: 1, insert: '' });
        expect(diffTextValue('h', '')).toEqual({ deletes: 1, insert: '' });
    });

    it('word delete removes many chars in ONE event (Gboard long-press delete)', () => {
        // v1 sent a single \x7f per event regardless of how much was removed —
        // leaving residue. The diff counts the actual removal.
        expect(diffTextValue('git status', 'git ')).toEqual({ deletes: 6, insert: '' });
    });

    it('autocorrect replaces the last word (insertReplacementText)', () => {
        // v1 ignored this inputType entirely → keyboard and pty diverged.
        // End-relative: delete back to the divergence point, retype the rest.
        expect(diffTextValue('helo ', 'hello ')).toEqual({ deletes: 2, insert: 'lo ' });
    });

    it('IME commit appends a whole word (composition commit diff)', () => {
        expect(diffTextValue('', '你好')).toEqual({ deletes: 0, insert: '你好' });
        expect(diffTextValue('say ', 'say 你好')).toEqual({ deletes: 0, insert: '你好' });
    });

    it('Gboard recomposition delete: committed word shrinks by one per press', () => {
        // Backspacing into a committed word re-opens it as a composition; the
        // net effect of that composition is a plain one-char removal. xterm's
        // own _finalizeComposition sends NOTHING here (substring bookkeeping
        // assumes appended text) — the "letters can't be deleted" bug.
        expect(diffTextValue('hello', 'hell')).toEqual({ deletes: 1, insert: '' });
        expect(diffTextValue('hell', '')).toEqual({ deletes: 4, insert: '' });
    });

    it('counts CODE POINTS for deletes (one \\x7f erases one code point)', () => {
        // '👍' is 2 UTF-16 units but 1 code point → 1 delete, not 2.
        expect(diffTextValue('a👍', 'a')).toEqual({ deletes: 1, insert: '' });
        expect(diffTextValue('中文字', '中')).toEqual({ deletes: 2, insert: '' });
    });

    it('does not split surrogate pairs at diff boundaries', () => {
        // Same leading surrogate on both sides ('👍' vs '👎' share the high
        // surrogate): a naive prefix diff would slice mid-pair.
        const d = diffTextValue('👍', '👎');
        expect(d.deletes).toBe(1);
        expect(d.insert).toBe('👎');
    });

    it('mid-string edits collapse to delete-to-divergence + retype (end-relative)', () => {
        expect(diffTextValue('abXcd', 'abYcd')).toEqual({ deletes: 3, insert: 'Ycd' });
        expect(diffTextValue('abcd', 'abXYcd')).toEqual({ deletes: 2, insert: 'XYcd' });
    });

    it('full replacement', () => {
        expect(diffTextValue('foo', 'barbaz')).toEqual({ deletes: 3, insert: 'barbaz' });
    });
});

describe('toPtyText', () => {
    it('normalizes newlines to CR for the pty', () => {
        expect(toPtyText('ls\n')).toBe('ls\r');
        expect(toPtyText('a\r\nb\nc')).toBe('a\rb\rc');
        expect(toPtyText('plain')).toBe('plain');
    });
});
