import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createTeamsClient, TeamConnectionPreflightError } from './client';
import { teamScopePath } from './context';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { TEAM_SKILL } from './resources';

export const TEAMS_ADOPT_CAPABILITY = 'teams-adopt-v1';
export const TeamAdoptSchema = z.object({
    requestId: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(128),
    teamId: z.string().min(1).max(128).optional(),
}).strict();
export type TeamAdoptInput = z.infer<typeof TeamAdoptSchema>;
export type TeamAdoptResult = { status: 'pending'; requestId: string }
    | { status: 'connected'; teamId: string; botId: string; instructions: string }
    | { error: string; safeToChange?: boolean };

/** Durable intent contains no credential. A different request cannot replace an uncertain adoption. */
async function retainIntent(path: string, input: TeamAdoptInput): Promise<{ resolvedTeamId?: string; guidanceDelivered?: boolean; fresh?: boolean }> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error: any) { if (error.code !== 'EEXIST') throw new Error('Cannot retain team connection request'); }
    if (file) {
        try { await file.writeFile(JSON.stringify(input)); await file.sync(); }
        finally { await file.close(); }
        return { fresh: true };
    }
    const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await existing.stat();
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Unsafe team connection receipt');
        const stored = JSON.parse(await existing.readFile('utf8'));
        const { resolvedTeamId, guidanceDelivered, ...request } = stored;
        const previous = TeamAdoptSchema.parse(request);
        if (JSON.stringify(previous) !== JSON.stringify(input)) throw new Error('Another team connection request already exists; retry the original request');
        if (resolvedTeamId !== undefined && (typeof resolvedTeamId !== 'string' || !resolvedTeamId)) throw new Error('Invalid connection receipt');
        if (guidanceDelivered !== undefined && typeof guidanceDelivered !== 'boolean') throw new Error('Invalid guidance receipt');
        return { resolvedTeamId, guidanceDelivered };
    } finally { await existing.close(); }
}

async function retainTeam(path: string, input: TeamAdoptInput, resolvedTeamId: string, guidanceDelivered = false): Promise<void> {
    const temporary = `${path}.${randomUUID()}.new`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ ...input, resolvedTeamId, guidanceDelivered })); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
}

/** The RPC starts work and returns immediately; repeating its exact payload polls the same operation. */
export function createTeamAdoption(sessionId: string) {
    const client = createTeamsClient(sessionId);
    let current: { signature: string; result?: TeamAdoptResult; safeToChange?: boolean } | undefined;
    return (raw: unknown): TeamAdoptResult => {
        const parsed = TeamAdoptSchema.safeParse(raw);
        if (!parsed.success) return { error: 'Invalid team connection request' };
        if (process.env.VH_TEAM_SCOPE_FILE) return { error: 'Assigned team members cannot create or join another team' };
        let path: string;
        try { path = `${teamScopePath(sessionId)}.adopt.json`; }
        catch { return { error: 'A managed session identity is required' }; }
        const input = parsed.data;
        const signature = JSON.stringify(input);
        if (current) {
            if (current.signature !== signature && current.safeToChange) current = undefined;
            else if (current.signature !== signature) return { error: 'Another team connection request already exists; retry the original request' };
        }
        if (current) {
            const result = current.result;
            // Return the error once, allowing the exact request to retry recoverable network/write failures.
            if (result && 'error' in result) current = undefined;
            return result ?? { status: 'pending', requestId: input.requestId };
        }
        const operation: { signature: string; result?: TeamAdoptResult; safeToChange?: boolean } = { signature };
        current = operation;
        void (async () => {
            let intent: { resolvedTeamId?: string; guidanceDelivered?: boolean; fresh?: boolean } | undefined;
            try {
                intent = await retainIntent(path, input);
                const connected = await client.initialize(input, { resumeAdoption: true, expectedTeamId: intent.resolvedTeamId, onTeamResolved: teamId => retainTeam(path, input, teamId, intent?.guidanceDelivered) });
                const instructions = `${TEAM_SKILL}\n\nThis session is now connected as the team lead. Call team_inspect to read the authoritative state before continuing the user's goal. Do not call team_create or team_join again.`;
                if (!intent.guidanceDelivered) {
                    const key = await waitForSessionKey(sessionId, 10_000);
                    await sendUserMessage(sessionId, key, instructions, 'teams', { localId: `teams-adopt-${input.requestId}`, sentFrom: 'team' });
                    await retainTeam(path, input, connected.team.id, true);
                }
                operation.result = { status: 'connected', teamId: connected.team.id, botId: connected.botId, instructions };
            } catch (error) {
                if (error instanceof TeamConnectionPreflightError && intent?.fresh && !intent.resolvedTeamId) {
                    await unlink(path).catch(() => {});
                    operation.safeToChange = true;
                }
                operation.result = { error: error instanceof Error ? error.message : 'Team connection failed; retry the same request', ...(operation.safeToChange ? { safeToChange: true } : {}) };
            }
        })();
        return { status: 'pending', requestId: input.requestId };
    };
}
