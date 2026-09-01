import { describe, expect, it } from 'vitest';
import { resumePrecheck, sanitizeResumeModel } from './resumePrecheck';

const fsOk = { cwdExists: () => true, conversationExists: () => true };
const uuid = '123e4567-e89b-12d3-a456-426614174000';

describe('B-265 resumePrecheck', () => {
    it('claude: needs cwd, a uuid claudeSessionId and the JSONL on disk', () => {
        expect(resumePrecheck({ path: '/p', claudeSessionId: uuid }, fsOk)).toEqual({ ok: true });
        expect(resumePrecheck({ path: '/p', claudeSessionId: uuid }, { ...fsOk, cwdExists: () => false })).toMatchObject({ ok: false, reason: 'missing-cwd' });
        expect(resumePrecheck({ path: '/p' }, fsOk)).toMatchObject({ ok: false, reason: 'no-backend-id' });
        expect(resumePrecheck({ path: '/p', claudeSessionId: '../etc' }, fsOk)).toMatchObject({ ok: false, reason: 'no-backend-id' });
        expect(resumePrecheck({ path: '/p', claudeSessionId: uuid }, { ...fsOk, conversationExists: () => false })).toMatchObject({ ok: false, reason: 'conversation-missing' });
    });
    it('codex: thread id only; other flavors are refused', () => {
        expect(resumePrecheck({ path: '/p', flavor: 'codex', codexThreadId: 't' }, fsOk)).toEqual({ ok: true });
        expect(resumePrecheck({ path: '/p', flavor: 'codex' }, fsOk)).toMatchObject({ ok: false, reason: 'no-backend-id' });
        expect(resumePrecheck({ path: '/p', flavor: 'gemini', claudeSessionId: uuid }, fsOk)).toMatchObject({ ok: false, reason: 'unsupported-flavor' });
    });
    it('model values are charset-limited so they cannot become another flag', () => {
        expect(sanitizeResumeModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(sanitizeResumeModel('--dangerously-skip-permissions')).toBeNull();
        expect(sanitizeResumeModel('a b')).toBeNull();
        expect(sanitizeResumeModel(3)).toBeNull();
    });
});
