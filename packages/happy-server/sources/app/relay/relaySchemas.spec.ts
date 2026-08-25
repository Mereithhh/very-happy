import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RelayCandidateSchema, RelayClaimRequestSchema } from '@slopus/happy-wire';
import { ServerRelayCandidateSchema, ServerRelayClaimRequestSchema } from './relaySchemas';

describe('server relay source-overlay contract', () => {
    it('matches the client-facing happy-wire schema', () => {
        const samples = [
            { id: 'sg-hw', url: 'https://relay-sg.example.com', region: 'Singapore' },
            { id: '', url: 'not-a-url', region: '' },
            { id: 'x'.repeat(65), url: 'https://relay.example.com', region: 'US West' },
        ];
        for (const sample of samples) {
            expect(ServerRelayCandidateSchema.safeParse(sample).success)
                .toBe(RelayCandidateSchema.safeParse(sample).success);
        }

        const claims = [
            { relayId: 'sg-hw', probes: [{ relayId: 'sg-hw', rttMs: 12.5 }] },
            { relayId: 'sg-hw', probes: [{ relayId: 'sg-hw', rttMs: -1 }] },
            { relayId: 'sg-hw', probes: Array.from({ length: 33 }, () => ({ relayId: 'sg-hw', rttMs: 1 })) },
        ];
        for (const claim of claims) {
            expect(ServerRelayClaimRequestSchema.safeParse(claim).success)
                .toBe(RelayClaimRequestSchema.safeParse(claim).success);
        }
    });

    it('does not runtime-import new wire exports in bind-mounted relay sources', () => {
        const sources = [
            path.join(process.cwd(), 'sources/app/relay/relayConfig.ts'),
            path.join(process.cwd(), 'sources/app/relay/relayRegistry.ts'),
            path.join(process.cwd(), 'sources/app/api/routes/relayRoutes.ts'),
        ];
        for (const source of sources) {
            const text = fs.readFileSync(source, 'utf8');
            expect(text).not.toMatch(/import\s+(?!type\b)[^;]+from\s+['"]@slopus\/happy-wire['"]/u);
        }
    });
});
