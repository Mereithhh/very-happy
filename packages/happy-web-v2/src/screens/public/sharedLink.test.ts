import { describe, expect, it } from 'vitest';
import { pollFailureClears, mergeRecords, messagesFromRecords, phaseForStatus, pollIntervalMs, secretFromHash } from './sharedLink';

describe('B-701 share-link viewer helpers', () => {
    it('reads the secret from the fragment and rejects junk', () => {
        const secret = 'A'.repeat(43);
        expect(secretFromHash(`#${secret}`)).toBe(secret);
        expect(secretFromHash(`#s=${secret}`)).toBe(secret);
        expect(secretFromHash('')).toBeNull();
        expect(secretFromHash('#short')).toBeNull();
        expect(secretFromHash('#<script>alert(1)</script>xxxxxxxxxxxxxxxx')).toBeNull();
    });

    it('treats revoked and expired (410) the same, distinct from an unknown link', () => {
        expect(phaseForStatus(410)).toBe('gone');
        expect(phaseForStatus(404)).toBe('invalid');
        expect(phaseForStatus(429)).toBe('rateLimited');
        expect(phaseForStatus(500)).toBe('error');
    });

    it('a poll failure clears the page only for gone / invalid, never for a network blip or throttling', () => {
        expect(pollFailureClears(410)).toBe(true);
        expect(pollFailureClears(404)).toBe(true);
        expect(pollFailureClears(429)).toBe(false);
        expect(pollFailureClears(502)).toBe(false);
        expect(pollFailureClears(null)).toBe(false);
    });

    it('polls within the 5 s revocation bound', () => {
        expect(pollIntervalMs('live')).toBeLessThanOrEqual(5_000);
        expect(pollIntervalMs('snapshot')).toBeLessThanOrEqual(5_000);
    });

    it('merges pages by seq without duplicates', () => {
        const r = (seq: number) => ({ id: `m${seq}`, seq, createdAt: seq, content: {} });
        expect(mergeRecords([r(1), r(2)], [r(2), r(3)]).map((x) => x.seq)).toEqual([1, 2, 3]);
        expect(mergeRecords([r(3)], [r(1)]).map((x) => x.seq)).toEqual([1, 3]);
    });

    it('renders projected records through the normal reducer', () => {
        const messages = messagesFromRecords([
            { id: 'a', seq: 1, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'hello' } } },
            { id: 'b', seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi there' }] }, uuid: 'u1', parentUuid: null } } } },
            { id: 'c', seq: 3, createdAt: 3, content: { role: 'nonsense' } },
        ]);
        const texts = messages.map((m) => ('text' in m ? m.text : null));
        expect(texts).toContain('hello');
        expect(texts).toContain('hi there');
    });
});
