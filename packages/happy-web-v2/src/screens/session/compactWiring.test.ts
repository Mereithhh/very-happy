/**
 * Owner 10-30 (/compact answered by the model): the composer sends a standalone
 * /compact bare and canonical, and refuses it on a session that cannot compact.
 * The rules live in compactCommand.ts (own tests); these pin the composer's
 * call sites. Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');

describe('/compact in the composer', () => {
    it('a typed /compact is refused on a session that cannot compact, before anything is sent', () => {
        const doSend = source.slice(source.indexOf('const doSend = async'));
        const guardAt = doSend.indexOf("if (compactCommand !== null && compactSupport(session) === 'unsupported') {");
        expect(guardAt).toBeGreaterThan(0);
        expect(guardAt).toBeLessThan(doSend.indexOf('sendingRef.current = true;'));
        expect(doSend.slice(guardAt, guardAt + 200)).toMatch(/toast\.show\(t\('session\.chat\.compactUnsupported'\), 'info'\);\s*return;/);
    });

    it('a typed /compact goes canonical and without the edited-drafts block', () => {
        expect(source).toContain('const attachedDrafts = compactCommand !== null ? [] : selectPendingDrafts(');
        expect(source).toContain('const sendValue = compactCommand ?? appendEditedDrafts(value,');
    });

    it('a queued /compact is refused or canonicalised the same way', () => {
        const queued = source.slice(source.indexOf('const sendQueuedItem = async'), source.indexOf('const doAbort = async'));
        expect(queued).toMatch(/if \(compact !== null && compactSupport\(session\) === 'unsupported'\) \{\s*toast\.show\(t\('session\.chat\.compactUnsupported'\), 'info'\);\s*releaseQueuedAttachments\(item\);\s*return;/);
        expect(queued).toContain('if (compact !== null) item = { ...item, text: compact };');
    });

    it('the command list says when /compact is unavailable', () => {
        expect(source).toContain("item.unavailable ? t('session.chat.compactUnavailable') : t('session.chat.compactDescription')");
        expect(readFileSync(new URL('../../sync/suggestionCommands.ts', import.meta.url), 'utf8'))
            .toContain("compactUnavailable: compactSupport(session) === 'unsupported',");
    });
});
