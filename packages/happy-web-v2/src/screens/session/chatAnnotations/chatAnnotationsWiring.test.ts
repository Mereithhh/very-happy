import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Line comments only: AgentInput has `image/*` strings that a block-comment strip would eat.
const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('B-891 transcript comments wiring', () => {
    it('AgentInput sends the comments inside the text and drops exactly those drafts once accepted', () => {
        const src = read('../AgentInput.tsx');
        // composed into the text that is queued / sent (edited drafts appended after)
        expect(src).toMatch(/const sendValue = compactCommand \?\? appendEditedDrafts\(withNotes, /);
        expect(src).toMatch(/const withNotes = composeAnnotatedMessage\(attachedNotes, value, /);
        // `/compact` stays bare: no comments attached to it
        expect(src).toMatch(/const attachedNotes = compactCommand !== null \? \[\] : notes;/);
        // only after the send was accepted (sent, or a queue owns it) — a failure keeps them
        expect(src).toMatch(/if \(\(outcome !== 'failed' \|\| queueOwnsItem\) && attachedNotes\.length > 0\) \{\s*removeChatAnnotations\(sessionId, attachedNotes\.map\(\(a\) => a\.id\)\);/);
        // comments alone are sendable
        expect(src).toMatch(/const hasAnnotations = !pending && annotationCount > 0;\n\s*const hasDraft = [^\n]*\|\| hasAnnotations \|\|/);
        expect(src).toMatch(/\{!pending && <ChatAnnotationsTray sessionId=\{sessionId\} \/>\}/);
    });

    it('SharedComposer (driver) sends them too, clearing only after the server accepted', () => {
        const src = read('../SharedComposer.tsx');
        expect(src).toMatch(/await sendSharedMessage\(sessionId, body, [^\n]*\);\s*removeChatAnnotations\(sessionId, notes\.map\(\(a\) => a\.id\)\);/);
    });

    it('the 「批注」 entries and the transcript layer are gated on who may send', () => {
        expect(read('../SelectionQuote.tsx')).toMatch(/\{annotate && <button/);
        expect(read('../SelectionQuote.tsx')).toMatch(/const annotate = canAnnotateSession\(session\);/);
        expect(read('../MessageActions.tsx')).toMatch(/\{!send && selectionQuote && canAnnotateSession\(session\) && <button/);
        expect(read('../ChatList.tsx')).toMatch(/<ChatAnnotationLayer sessionId=\{sessionId\} innerRef=\{innerRef\} enabled=\{canAnnotateSession\(session\)\} \/>/);
    });
});
