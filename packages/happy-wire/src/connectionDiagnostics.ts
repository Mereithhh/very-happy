import { z } from 'zod';

/** Deliberately categorical: never send error messages, URLs, UA or terminal content. */
export const ConnectionDiagnosticEventSchema = z.object({
    attemptId: z.string().uuid(),
    machineId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
    at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    stage: z.enum(['control', 'relay_discovery', 'relay_connect', 'relay_probe', 'machine_rpc', 'terminal_open']),
    outcome: z.enum(['started', 'success', 'timeout', 'error', 'offline', 'cancelled', 'fallback']),
    durationMs: z.number().int().min(0).max(300_000),
    deviceClass: z.enum(['mobile', 'desktop', 'unknown']),
    visibility: z.enum(['visible', 'hidden']),
    relayRegion: z.enum(['central', 'sg', 'us', 'other', 'unknown']).optional(),
    timing: z.enum(['active', 'background', 'censored', 'unknown']).optional(),
    client: z.string().regex(/^web\/(?:[a-f0-9]{7,40}|unknown)$/),
}).strict();

export type ConnectionDiagnosticEvent = z.infer<typeof ConnectionDiagnosticEventSchema>;
export const ConnectionDiagnosticBatchSchema = z.object({
    events: z.array(ConnectionDiagnosticEventSchema).min(1).max(32),
}).strict();
