import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

installBrowserTestGlobals();

describe('chatAnnotationsStore (B-891)', () => {
    let mod: typeof import('./chatAnnotationsStore');
    let persistence: typeof import('@/sync/persistence');
    beforeAll(async () => {
        mod = await import('./chatAnnotationsStore');
        persistence = await import('@/sync/persistence');
    });
    const anchor = { seq: 3, quote: 'beta', prefix: 'alpha ', suffix: ' gamma', start: 6, excerpt: 'beta' };

    it('persists per session under its own namespace (survives a reload)', () => {
        expect(mod.addChatAnnotation('s1', anchor, 'note', 5)).toBe('ok');
        mod.addChatAnnotation('s2', anchor, 'other', 5);
        const raw = localStorage.getItem('mmkv:chat-annotations:s.s1');
        expect(JSON.parse(raw!)).toMatchObject([{ seq: 3, quote: 'beta', body: 'note' }]);
        expect(mod.getChatAnnotations('s2')).toHaveLength(1);
        expect(mod.getChatAnnotations('s1')).toBe(mod.getChatAnnotations('s1'));
    });

    it('edits, removes only what was sent, and deletes', () => {
        const [a] = mod.getChatAnnotations('s1');
        mod.addChatAnnotation('s1', { ...anchor, start: 0 }, 'second', 6);
        mod.updateChatAnnotation('s1', a.id, 'edited', 9);
        expect(mod.getChatAnnotations('s1')[0]).toMatchObject({ body: 'edited', updatedAt: 9 });
        mod.removeChatAnnotations('s1', [a.id]);
        expect(mod.getChatAnnotations('s1').map((c) => c.body)).toEqual(['second']);
        mod.deleteChatAnnotation('s1', mod.getChatAnnotations('s1')[0].id);
        expect(mod.getChatAnnotations('s1')).toEqual([]);
        expect(localStorage.getItem('mmkv:chat-annotations:s.s1')).toBeNull();
    });

    it('caps the per-session count', () => {
        for (let i = 0; i < 50; i++) mod.addChatAnnotation('cap', anchor, `n${i}`);
        expect(mod.addChatAnnotation('cap', anchor, 'one too many')).toBe('quota');
        expect(mod.getChatAnnotations('cap')).toHaveLength(50);
        mod.clearChatAnnotations('cap');
    });

    it('tracks stale ids: found clears, stale sets, unseen keep their state', () => {
        mod.reportAnchorState('s9', [], ['a', 'b']);
        expect([...mod.getStaleAnnotationIds('s9')]).toEqual(['a', 'b']);
        const before = mod.getStaleAnnotationIds('s9');
        mod.reportAnchorState('s9', [], ['a']);
        expect(mod.getStaleAnnotationIds('s9')).toBe(before); // no change → same snapshot
        mod.reportAnchorState('s9', ['a'], []);
        expect([...mod.getStaleAnnotationIds('s9')]).toEqual(['b']);
    });

    it('session deletion clears that session; logout clears all', () => {
        mod.addChatAnnotation('s3', anchor, 'x');
        persistence.clearDiffCommentDrafts('s2');
        expect(mod.getChatAnnotations('s2')).toEqual([]);
        expect(mod.getChatAnnotations('s3')).toHaveLength(1);
        persistence.clearPersistence();
        expect(mod.getChatAnnotations('s3')).toEqual([]);
    });
});
