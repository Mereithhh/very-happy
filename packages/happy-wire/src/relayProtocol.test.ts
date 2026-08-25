import { describe, expect, it } from 'vitest';
import {
    RelayAssignmentResponseSchema,
    RelayCandidatesResponseSchema,
    RelayClaimRequestSchema,
} from './relayProtocol';

describe('relay protocol', () => {
    it('accepts bounded discovery and claim payloads', () => {
        expect(RelayCandidatesResponseSchema.parse({
            enabled: true,
            candidates: [{ id: 'sin', url: 'https://relay-sin.example.com', region: 'ap-southeast-1' }],
            assignmentTtlMs: 75_000,
        }).enabled).toBe(true);
        expect(RelayClaimRequestSchema.parse({ relayId: 'sin', probes: [{ relayId: 'sin', rttMs: 12.5 }] }).probes).toHaveLength(1);
    });

    it('rejects unsafe or unbounded relay data', () => {
        expect(() => RelayClaimRequestSchema.parse({ relayId: 'sin', probes: [{ relayId: 'sin', rttMs: -1 }] })).toThrow();
        expect(() => RelayAssignmentResponseSchema.parse({ assignment: { relayId: 'sin', url: 'not-a-url' } })).toThrow();
    });
});
