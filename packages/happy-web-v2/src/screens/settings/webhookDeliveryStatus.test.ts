import { describe, expect, it } from 'vitest';
import { webhookHealth } from './webhookDeliveryStatus';

const base = { since: 0, delivered: 0, failed: 0, retries: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null };

describe('B-026 webhookHealth', () => {
    it('idle before anything is sent, ok when everything arrived (retries included)', () => {
        expect(webhookHealth(base)).toBe('idle');
        expect(webhookHealth({ ...base, delivered: 3, retries: 2, lastSuccessAt: 5 })).toBe('ok');
    });
    it('failing when the latest outcome was a give-up; recovered once a later one arrives', () => {
        expect(webhookHealth({ ...base, failed: 1, lastFailureAt: 9, lastError: 'HTTP 502' })).toBe('failing');
        expect(webhookHealth({ ...base, delivered: 2, failed: 1, lastSuccessAt: 5, lastFailureAt: 9 })).toBe('failing');
        expect(webhookHealth({ ...base, delivered: 2, failed: 1, lastSuccessAt: 12, lastFailureAt: 9 })).toBe('recovered');
    });
});
