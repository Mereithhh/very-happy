import { z } from 'zod';
import type { Machine } from './storageTypes';

/**
 * B-276 — daemon-context Claude auth preflight as published in
 * `daemonState.claudeAuth` (spec 2026-09-claude-auth-preflight). daemonState is
 * `any` on the web and survives daemon restarts on the server, so this is the
 * single trust gate: only a value written by the CURRENT daemon run
 * (`daemonPid === daemonState.pid`) with a known probe version is rendered.
 * Old CLIs never write the field → `null` → no UI at all.
 */
export const ClaudeAuthStateSchema = z.object({
    probeVersion: z.number(),
    daemonPid: z.number(),
    status: z.string(),
    authMethod: z.string().optional(),
    subscriptionType: z.string().optional(),
    diagnosis: z.string().optional(),
    detail: z.string().optional(),
    repairable: z.string().optional(),
    context: z.object({
        platform: z.string(),
        lineage: z.string(),
        credentialStore: z.string(),
    }),
    checkedAt: z.number(),
});

export type ClaudeAuthState = z.infer<typeof ClaudeAuthStateSchema>;

export const CLAUDE_AUTH_STALE_AFTER_MS = 60 * 60 * 1000;

export function parseClaudeAuth(daemonState: unknown): ClaudeAuthState | null {
    if (!daemonState || typeof daemonState !== 'object') return null;
    const raw = (daemonState as { claudeAuth?: unknown }).claudeAuth;
    const parsed = ClaudeAuthStateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.probeVersion < 1) return null;
    const pid = (daemonState as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || parsed.data.daemonPid !== pid) return null;
    return parsed.data;
}

export function readClaudeAuth(machine: Pick<Machine, 'daemonState'> | null | undefined): ClaudeAuthState | null {
    return machine ? parseClaudeAuth(machine.daemonState) : null;
}

export type ClaudeAuthTone = 'live' | 'err' | 'muted' | 'warn';

export function claudeAuthTone(state: ClaudeAuthState, now = Date.now()): ClaudeAuthTone {
    if (now - state.checkedAt > CLAUDE_AUTH_STALE_AFTER_MS) return 'warn';
    switch (state.status) {
        case 'ok': return 'live';
        case 'not-logged-in':
        case 'error':
        case 'claude-missing': return 'err';
        default: return 'muted';
    }
}

export function isClaudeAuthStale(state: ClaudeAuthState, now = Date.now()): boolean {
    return now - state.checkedAt > CLAUDE_AUTH_STALE_AFTER_MS;
}
