import { describe, expect, it } from 'vitest';
import { resolveRelaunchMetadata } from './relaunchMetadata';

describe('resolveRelaunchMetadata', () => {
    it('prefers the server copy even when the snapshot already has an agent id (stale after an edit)', async () => {
        const r = await resolveRelaunchMetadata({ claudeSessionId: 'pre-edit' }, async () => ({ claudeSessionId: 'rewound' }));
        expect(r).toEqual({ metadata: { claudeSessionId: 'rewound' }, source: 'server' });
    });
    it('falls back to the snapshot when the server has nothing or fails', async () => {
        expect((await resolveRelaunchMetadata({ claudeSessionId: 'a' }, async () => null)).source).toBe('snapshot');
        expect((await resolveRelaunchMetadata({ claudeSessionId: 'a' }, async () => { throw new Error('offline'); })).metadata).toEqual({ claudeSessionId: 'a' });
    });
});

describe('daemon resume and restart relaunch from the server copy', () => {
    it('both paths go through resolveRelaunchMetadata, not the needs-fetch shortcut', async () => {
        const { readFileSync } = await import('node:fs');
        const run = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
        expect(run.match(/await resolveRelaunchMetadata\(tracked\.happySessionMetadataFromLocalWebhook,/g)).toHaveLength(2);
        expect(run).not.toContain('const needsFetch');
    });
});
