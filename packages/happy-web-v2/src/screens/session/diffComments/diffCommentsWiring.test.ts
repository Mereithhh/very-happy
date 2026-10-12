import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('B-554 diff-comment drafts wiring', () => {
    it('a deleted session drops its drafts in the onSessionDeleted purge', () => {
        const src = stripComments(readFileSync(new URL('../../../sync/sync.ts', import.meta.url), 'utf8'));
        const start = src.indexOf('public onSessionDeleted = (sessionId: string) => {');
        expect(start).toBeGreaterThan(-1);
        const body = src.slice(start, src.indexOf('\n    }', start));
        expect(body).toMatch(/\n\s*clearDiffCommentDrafts\(sessionId\);/);
    });
});
