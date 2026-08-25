import { z } from 'zod';

// Keep the control server's source-overlay runtime independent from newly
// added happy-wire exports. Production intentionally bind-mounts server source
// over an older immutable image; importing a new named export here would make
// Node fail before the server can start. The contract test keeps these schemas
// aligned with happy-wire, which remains the client-facing source of truth.
export const ServerRelayCandidateSchema = z.object({
    id: z.string().min(1).max(64),
    url: z.string().url(),
    region: z.string().min(1).max(64),
});

export type ServerRelayCandidate = z.infer<typeof ServerRelayCandidateSchema>;

export const ServerRelayProbeSchema = z.object({
    relayId: z.string().min(1).max(64),
    rttMs: z.number().finite().nonnegative().max(60_000),
});

export type ServerRelayProbe = z.infer<typeof ServerRelayProbeSchema>;

export const ServerRelayClaimRequestSchema = z.object({
    relayId: z.string().min(1).max(64),
    probes: z.array(ServerRelayProbeSchema).max(32),
});
