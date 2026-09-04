import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import {
    ATTACHED_FILES_NOTE,
    dropDuplicateAttachmentEchoes,
    isDuplicateAttachmentEcho,
    hasAttachedFilesBlock,
    parseAttachedFiles,
    stripAttachedFiles,
} from './attachedFiles';
import { stripHarnessBlocks } from './harness';

const manifest = '{"path":"/Users/jojo/.happy/uploads/chat/s1/resume-abc.pdf","name":"resume.pdf","mimeType":"application/pdf","size":101268}';
const augmented = (prose: string) => `${prose}\n\n<attached_files>\n${manifest}\n</attached_files>\n${ATTACHED_FILES_NOTE}`;

const user = (id: string, text: string, sentFrom?: string): Message => ({
    kind: 'user-text', id, localId: null, createdAt: 1, text,
    ...(sentFrom ? { meta: { sentFrom } } : {}),
} as Message);

describe('parseAttachedFiles', () => {
    it('reads the manifest', () => {
        expect(parseAttachedFiles(augmented('看看这个'))).toEqual([{
            path: '/Users/jojo/.happy/uploads/chat/s1/resume-abc.pdf',
            name: 'resume.pdf',
            mimeType: 'application/pdf',
            size: 101268,
        }]);
    });

    it('returns nothing for ordinary text and survives a malformed line', () => {
        expect(parseAttachedFiles('hello')).toEqual([]);
        expect(parseAttachedFiles('<attached_files>\n{not json\n</attached_files>')).toEqual([]);
    });
});

describe('stripAttachedFiles', () => {
    it('removes the block and the trailing instruction', () => {
        expect(stripAttachedFiles(augmented('看看这个'))).toBe('看看这个');
    });

    it('leaves ordinary text alone', () => {
        expect(stripAttachedFiles('no attachments here')).toBe('no attachments here');
    });

    it('handles an attachment-only message', () => {
        expect(stripAttachedFiles(augmented(''))).toBe('');
    });

    it('is deliberately NOT part of stripHarnessBlocks — that also runs over agent prose', () => {
        // The CLI only ever appends the manifest to a USER prompt, and agents in
        // this repository legitimately discuss the tag (specs, CLI source). When
        // it lived in stripHarnessBlocks it silently destroyed body text,
        // including fenced examples.
        expect(hasAttachedFilesBlock(augmented('x'))).toBe(true);
        const agentProse = 'The CLI appends this:\n\n```\n<attached_files>\n{"path":"/x"}\n</attached_files>\n```\n\nand then a note.';
        expect(stripHarnessBlocks(agentProse)).toBe(agentProse);
        expect(stripHarnessBlocks('what does <attached_files>x</attached_files> mean?'))
            .toBe('what does <attached_files>x</attached_files> mean?');
    });
});

describe('duplicate echo detection', () => {
    it('drops the CLI echo of a message the user sent from this client', () => {
        const messages = [user('a', '看看这个', 'web'), user('b', augmented('看看这个'))];
        expect(isDuplicateAttachmentEcho(messages[1], [messages[0]])).toBe(true);
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['a']);
    });

    it('keeps a genuinely repeated message — the user really did send it twice', () => {
        // no manifest → never a candidate, no matter how identical
        const messages = [user('a', '继续', 'web'), user('b', '继续', 'web')];
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('keeps a CLI-originated attachment message that has no matching predecessor', () => {
        const messages = [user('a', '别的话', 'web'), user('b', augmented('看看这个'))];
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('never drops a message this client sent (it always carries sentFrom)', () => {
        const messages = [user('a', '看看这个', 'web'), user('b', augmented('看看这个'), 'web')];
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('returns the SAME array when there is nothing to drop (memo identity)', () => {
        const messages = [user('a', 'x', 'web')];
        expect(dropDuplicateAttachmentEchoes(messages)).toBe(messages);
    });

    it('normalises blank runs on BOTH sides (they were folded on one branch only)', () => {
        const prose = 'line one\n\n\n\nline two';
        const messages = [user('a', prose, 'web'), user('b', augmented(prose))];
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['a']);
    });

    it('known edge: with the original on an earlier page, the echo survives', () => {
        const messages = [user('b', augmented('看看这个'))];
        expect(dropDuplicateAttachmentEchoes(messages).map((m) => m.id)).toEqual(['b']);
    });
});
