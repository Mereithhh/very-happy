import { describe, expect, it } from 'vitest';
import { preserveSessionActivityFromStore, preserveSessionBatchActivityFromStore } from './sessionSnapshot';

describe('preserveSessionActivityFromStore', () => {
    const snapshot = { id: 'session-a', thinking: false, thinkingAt: 0, seq: 3 };

    it('keeps a live activity state across a durable HTTP snapshot refresh', () => {
        expect(preserveSessionActivityFromStore(snapshot, { thinking: true, thinkingAt: 1234 })).toEqual({
            ...snapshot,
            thinking: true,
            thinkingAt: 1234,
        });
    });

    it('keeps a cold session idle', () => {
        expect(preserveSessionActivityFromStore(snapshot, undefined)).toEqual(snapshot);
    });

    it('does not turn an authoritative idle state into thinking', () => {
        expect(preserveSessionActivityFromStore(snapshot, { thinking: false, thinkingAt: 999 })).toEqual(snapshot);
    });
});

describe('preserveSessionBatchActivityFromStore', () => {
    it('uses the single latest store snapshot for the complete fetched batch', () => {
        const fetched = [
            { id: 'a', thinking: false, thinkingAt: 0 },
            { id: 'b', thinking: false, thinkingAt: 0 },
        ];
        expect(preserveSessionBatchActivityFromStore(fetched, {
            a: { thinking: false, thinkingAt: 20 },
            b: { thinking: true, thinkingAt: 30 },
        })).toEqual([
            { id: 'a', thinking: false, thinkingAt: 0 },
            { id: 'b', thinking: true, thinkingAt: 30 },
        ]);
    });
});
