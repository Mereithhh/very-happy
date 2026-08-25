import { z } from 'zod';

export const RelayCandidateSchema = z.object({
    id: z.string().min(1).max(64),
    url: z.string().url(),
    region: z.string().min(1).max(64),
});

export type RelayCandidate = z.infer<typeof RelayCandidateSchema>;

export const RelayProbeSchema = z.object({
    relayId: z.string().min(1).max(64),
    rttMs: z.number().finite().nonnegative().max(60_000),
});

export type RelayProbe = z.infer<typeof RelayProbeSchema>;

export const RelayCandidatesResponseSchema = z.object({
    enabled: z.boolean(),
    candidates: z.array(RelayCandidateSchema).max(32),
    assignmentTtlMs: z.number().int().positive(),
});

export type RelayCandidatesResponse = z.infer<typeof RelayCandidatesResponseSchema>;

export const RelayClaimRequestSchema = z.object({
    relayId: z.string().min(1).max(64),
    probes: z.array(RelayProbeSchema).max(32),
});

export type RelayClaimRequest = z.infer<typeof RelayClaimRequestSchema>;

export const RelayAssignmentSchema = z.object({
    relayId: z.string().min(1).max(64),
    url: z.string().url(),
    region: z.string().min(1).max(64),
    token: z.string().min(1),
    expiresAt: z.number().int().positive(),
});

export type RelayAssignment = z.infer<typeof RelayAssignmentSchema>;

export const RelayAssignmentResponseSchema = z.object({
    assignment: RelayAssignmentSchema.nullable(),
});

export type RelayAssignmentResponse = z.infer<typeof RelayAssignmentResponseSchema>;

export const RelayHealthSchema = z.object({
    ok: z.literal(true),
    relayId: z.string().min(1).max(64),
    region: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
});

export type RelayHealth = z.infer<typeof RelayHealthSchema>;
