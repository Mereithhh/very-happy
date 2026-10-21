import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resumePrecheck, resumeStartsFreshConversation, sanitizeResumeModel } from './resumePrecheck';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';

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
    it('B-633: pi (acp flavor) needs its recorded pi session id and the cwd; other acp sessions stay refused', () => {
        expect(resumePrecheck({ path: '/p', flavor: 'acp', piSessionId: 'pi-1' }, { ...fsOk, conversationExists: () => false })).toEqual({ ok: true });
        expect(resumePrecheck({ path: '/p', flavor: 'acp', piSessionId: 'pi-1' }, { ...fsOk, cwdExists: () => false })).toMatchObject({ ok: false, reason: 'missing-cwd' });
        expect(resumePrecheck({ path: '/p', flavor: 'acp' }, fsOk)).toMatchObject({ ok: false, reason: 'unsupported-flavor' });
    });
    it('model values are charset-limited so they cannot become another flag', () => {
        expect(sanitizeResumeModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(sanitizeResumeModel('opus[1m]')).toBe('opus[1m]');
        expect(sanitizeResumeModel('fable[1m]')).toBe('fable[1m]');
        expect(sanitizeResumeModel('opus[2m]')).toBeNull();
        expect(sanitizeResumeModel('[1m]')).toBeNull();
        expect(sanitizeResumeModel('--dangerously-skip-permissions')).toBeNull();
        expect(sanitizeResumeModel('a b')).toBeNull();
        expect(sanitizeResumeModel(3)).toBeNull();
    });
});

describe('B-680 a never-run session resumes as a fresh conversation', () => {
    it('no-backend-id and conversation-missing start fresh; bad cwd / flavor stay fatal', () => {
        expect(resumeStartsFreshConversation('no-backend-id')).toBe(true);
        expect(resumeStartsFreshConversation('conversation-missing')).toBe(true);
        expect(resumeStartsFreshConversation('missing-cwd')).toBe(false);
        expect(resumeStartsFreshConversation('unsupported-flavor')).toBe(false);
    });
    it('the fresh launch reuses the happy session in its cwd with no --resume (claude + codex)', () => {
        const claude = buildResumeLaunch({ id: 's', active: false, metadata: { path: '/p', host: 'h' } as never }, { startedBy: 'daemon', claudeStartingMode: 'remote', freshConversation: true });
        expect(claude).toEqual({ cwd: '/p', args: ['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon'] });
        const codex = buildResumeLaunch({ id: 's', active: false, metadata: { path: '/p', host: 'h', flavor: 'codex' } as never }, { startedBy: 'daemon', freshConversation: true });
        expect(codex.args).not.toContain('--resume');
    });
    it('the daemon resume path routes precheck failures through it', () => {
        const run = readFileSync(join(__dirname, 'run.ts'), 'utf8').replace(/\/\/.*$/gm, '');
        expect(run).toContain('if (resumeStartsFreshConversation(precheck.reason)) {');
    });
});
