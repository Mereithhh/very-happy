/**
 * Wire-schema tolerance (B-051 review W6): the server's buildNewFeedPostUpdate
 * does not send `repeatKey`, so the client schema must accept a missing field
 * — requiring it made zod drop every live feed push ("Invalid update data").
 * Old-client-tolerates-missing-fields is a design requirement (CLAUDE.md #4).
 */
import { describe, it, expect } from 'vitest';
import { ApiNewFeedPostSchema, ApiUpdateSchema } from './apiTypes';

const basePost = {
    t: 'new-feed-post' as const,
    id: 'feed-1',
    body: { kind: 'text' as const, text: 'hello' },
    cursor: '0-42',
    createdAt: 1_700_000_000_000,
};

describe('ApiNewFeedPostSchema repeatKey tolerance', () => {
    it('accepts a payload WITHOUT repeatKey (live server pushes omit it)', () => {
        const parsed = ApiNewFeedPostSchema.safeParse(basePost);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.repeatKey ?? null).toBeNull();
    });

    it('still accepts explicit null and string repeatKey', () => {
        expect(ApiNewFeedPostSchema.safeParse({ ...basePost, repeatKey: null }).success).toBe(true);
        const withKey = ApiNewFeedPostSchema.safeParse({ ...basePost, repeatKey: 'rk-1' });
        expect(withKey.success).toBe(true);
        if (withKey.success) expect(withKey.data.repeatKey).toBe('rk-1');
    });

    it('a repeatKey-less push passes the top-level ApiUpdateSchema union', () => {
        const parsed = ApiUpdateSchema.safeParse(basePost);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.t).toBe('new-feed-post');
    });
});

describe('B-509 prompt-queue update', () => {
    it('validates the server snapshot shape so the sync loop routes it', async () => {
        const { ApiUpdateContainerSchema } = await import('./apiTypes');
        const parsed = ApiUpdateContainerSchema.safeParse({
            id: 'u1', seq: 1, createdAt: 1,
            body: { t: 'prompt-queue', sid: 's1', items: [{ id: 'i', localId: 'l', position: 1, content: { t: 'encrypted', c: 'x' }, createdAt: 1, updatedAt: 1 }] },
        });
        expect(parsed.success).toBe(true);
    });
});
