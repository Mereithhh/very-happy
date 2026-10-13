import { describe, expect, it } from 'vitest';
import { describeTestPushResult, runNotificationOptIn, shouldOfferNotificationOptIn, testPushUnavailable, type OptInGateInput } from './notificationOnboarding';

const base: OptInGateInput = {
    supported: true,
    permission: 'default',
    dismissed: false,
    installPromptVisible: false,
    onNotificationSettings: false,
};

describe('shouldOfferNotificationOptIn (B-570)', () => {
    it('offers only while the decision is open', () => {
        expect(shouldOfferNotificationOptIn(base)).toBe(true);
        expect(shouldOfferNotificationOptIn({ ...base, permission: 'granted' })).toBe(false);
        expect(shouldOfferNotificationOptIn({ ...base, permission: 'denied' })).toBe(false);
        expect(shouldOfferNotificationOptIn({ ...base, permission: 'unsupported' })).toBe(false);
        expect(shouldOfferNotificationOptIn({ ...base, supported: false })).toBe(false);
        expect(shouldOfferNotificationOptIn({ ...base, dismissed: true })).toBe(false);
    });
    it('yields to the PWA install card and to the notification settings page', () => {
        expect(shouldOfferNotificationOptIn({ ...base, installPromptVisible: true })).toBe(false);
        expect(shouldOfferNotificationOptIn({ ...base, onNotificationSettings: true })).toBe(false);
    });
});

describe('describeTestPushResult (B-570)', () => {
    const ok = (o: Partial<{ configured: boolean; total: number; sent: number; failed: number; pruned: number }>) =>
        ({ kind: 'ok' as const, configured: true, total: 1, sent: 1, failed: 0, pruned: 0, ...o });
    it('maps every outcome', () => {
        expect(describeTestPushResult(ok({ total: 2, sent: 2 }))).toEqual({ key: 'notifications.testPushSent', params: { count: 2 } });
        expect(describeTestPushResult(ok({ total: 3, sent: 2, failed: 1 }))).toEqual({ key: 'notifications.testPushSentPartial', params: { sent: 2, failed: 1 } });
        expect(describeTestPushResult(ok({ total: 0, sent: 0 }))).toEqual({ key: 'notifications.testPushNoDevices' });
        expect(describeTestPushResult(ok({ total: 2, sent: 0, failed: 2, pruned: 2 }))).toEqual({ key: 'notifications.testPushNoDevices' });
        expect(describeTestPushResult(ok({ total: 2, sent: 0, failed: 2, pruned: 0 }))).toEqual({ key: 'notifications.testPushFailed' });
        expect(describeTestPushResult(ok({ configured: false, sent: 0 }))).toEqual({ key: 'notifications.testPushNotConfigured' });
        expect(describeTestPushResult({ kind: 'unsupported' })).toEqual({ key: 'notifications.testPushUnsupported' });
        expect(describeTestPushResult({ kind: 'rate-limited' })).toEqual({ key: 'notifications.testPushRateLimited' });
        expect(describeTestPushResult({ kind: 'error' })).toEqual({ key: 'notifications.testPushFailed' });
    });
    it('only a 404 disables the button', () => {
        expect(testPushUnavailable({ kind: 'unsupported' })).toBe(true);
        expect(testPushUnavailable({ kind: 'error' })).toBe(false);
        expect(testPushUnavailable(null)).toBe(false);
    });
});

describe('runNotificationOptIn (review #5)', () => {
    it('requests permission first, then subscribes', async () => {
        const order: string[] = [];
        const out = await runNotificationOptIn({
            requestPermission: async () => { order.push('perm'); return 'granted'; },
            enablePush: async () => { order.push('push'); return true; },
        });
        expect(out).toBe('enabled');
        expect(order).toEqual(['perm', 'push']);
    });
    it('subscription failure or throw → failed, never rejects', async () => {
        await expect(runNotificationOptIn({ requestPermission: async () => 'granted', enablePush: async () => false })).resolves.toBe('failed');
        await expect(runNotificationOptIn({ requestPermission: async () => 'granted', enablePush: async () => { throw new Error('subscribe'); } })).resolves.toBe('failed');
        await expect(runNotificationOptIn({ requestPermission: async () => { throw new Error('x'); }, enablePush: null })).resolves.toBe('failed');
        await expect(runNotificationOptIn({ requestPermission: async () => 'granted', enablePush: null })).resolves.toBe('failed');
    });
    it('denied → denied without subscribing', async () => {
        let called = false;
        await expect(runNotificationOptIn({ requestPermission: async () => 'denied', enablePush: async () => { called = true; return true; } })).resolves.toBe('denied');
        expect(called).toBe(false);
    });
});
