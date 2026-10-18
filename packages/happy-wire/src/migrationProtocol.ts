import { z } from 'zod';

/**
 * B-627: a relay that is being retired tells each connected daemon where its
 * account now lives. The daemon exchanges `handoff` (signed by the old relay,
 * verified by the new one with the shared MIGRATION_HANDOFF_SECRET) for a
 * token at `url`, rewrites its settings and credentials, and hands over to a
 * fresh daemon process pointed at the new relay.
 */
export const ServerMigrateNoticeSchema = z.object({
    url: z.string().url().max(512),
    webappUrl: z.string().url().max(512),
    handoff: z.string().regex(/^vh1\.[A-Za-z0-9_-]{16,2048}\.[A-Za-z0-9_-]{43}$/),
    issuedAt: z.number().int().positive(),
});

export type ServerMigrateNotice = z.infer<typeof ServerMigrateNoticeSchema>;
