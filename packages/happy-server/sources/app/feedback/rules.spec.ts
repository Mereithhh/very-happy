import { describe, expect, it } from 'vitest';
import {
    createPushThrottle, FeedbackDiagnosticsSchema, FeedbackPostSchema, feedbackAdminIds, feedbackPushPresentation,
    isFeedbackAdmin, ratingToScore, routePattern, scoreToRating,
} from './rules';

describe('feedback rules (B-836)', () => {
    it('admin list comes only from VH_FEEDBACK_ADMIN_ACCOUNT_IDS; unset means nobody', () => {
        expect(feedbackAdminIds(undefined).size).toBe(0);
        expect(feedbackAdminIds('').size).toBe(0);
        expect([...feedbackAdminIds(' a, b\nc ,,')]).toEqual(['a', 'b', 'c']);
        expect(isFeedbackAdmin('b', 'a,b')).toBe(true);
        expect(isFeedbackAdmin('ab', 'a,b')).toBe(false);
        expect(isFeedbackAdmin('a', undefined)).toBe(false);
    });

    it('ratings map to 1..3 and back', () => {
        expect([ratingToScore('bad'), ratingToScore('ok'), ratingToScore('good')]).toEqual([1, 2, 3]);
        expect([scoreToRating(1), scoreToRating(2), scoreToRating(3)]).toEqual(['bad', 'ok', 'good']);
    });

    it('route pattern drops query/hash and replaces id-like segments', () => {
        expect(routePattern('/session/cmvph7gqg03ifrz2uk2cweyto?panel=board#x')).toBe('/session/:id');
        expect(routePattern('/machine/8800f02a-f4a4-4d0e-ba6d-79cb3790da0c/terminal')).toBe('/machine/:id/terminal');
        expect(routePattern('/teams/529e51396854697d741b90c9877109514c8610102a7d93105b9fa735ddf761b2')).toBe('/teams/:id');
        expect(routePattern('/settings/appearance')).toBe('/settings/appearance');
        expect(routePattern('/projects/42')).toBe('/projects/:id');
        expect(routePattern('?only=query')).toBe('/');
    });

    it('diagnostics keep only whitelisted keys and the route as a pattern', () => {
        const parsed = FeedbackDiagnosticsSchema.parse({
            webVersion: '2.1.0', route: '/session/cmvph7gqg03ifrz2uk2cweyto?x=1', pointer: 'coarse',
            sessionTitle: 'secret', messages: ['hello'], machineName: 'mac-office',
        });
        expect(parsed).toEqual({ webVersion: '2.1.0', route: '/session/:id', pointer: 'coarse' });
    });

    it('post schema: rating required, text ≤ 2000 trimmed, source defaults to manual', () => {
        expect(FeedbackPostSchema.safeParse({ text: 'x' }).success).toBe(false);
        expect(FeedbackPostSchema.parse({ rating: 'good', text: '  hi  ' })).toEqual({ rating: 'good', text: 'hi', source: 'manual' });
        expect(FeedbackPostSchema.safeParse({ rating: 'good', text: 'x'.repeat(2001) }).success).toBe(false);
        expect(FeedbackPostSchema.safeParse({ rating: 'great' }).success).toBe(false);
    });

    it('push copy names the sender, falls back when there is no text, counts coalesced rows', () => {
        expect(feedbackPushPresentation({ rating: 'bad', text: null, from: 'jojo', extra: 0 }))
            .toEqual({ title: '新反馈 · 👎 不好用', body: 'jojo：（未填写文字）' });
        expect(feedbackPushPresentation({ rating: 'good', text: 'y'.repeat(200), from: 'a', extra: 2 }).title).toBe('新反馈 · 👍 好用（另有 2 条）');
        expect(feedbackPushPresentation({ rating: 'good', text: 'y'.repeat(200), from: 'a', extra: 0 }).body).toHaveLength(2 + 80);
    });

    it('push throttle: one push per admin per window, skipped rows counted into the next', () => {
        const throttle = createPushThrottle(1000);
        expect(throttle.take('a', 0)).toBe(0);
        expect(throttle.take('a', 500)).toBeNull();
        expect(throttle.take('a', 900)).toBeNull();
        expect(throttle.take('b', 900)).toBe(0);
        expect(throttle.take('a', 1000)).toBe(2);
        expect(throttle.take('a', 1500)).toBeNull();
    });
});
