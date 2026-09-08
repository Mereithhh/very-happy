import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configuration, normalizeHttpEndpoint } from '@/configuration';

export const TeamScopeSchema = z.object({
    serverUrl: z.string(), scopeToken: z.string().min(1), teamId: z.string().min(1),
    botId: z.string().min(1), taskId: z.string().optional(), attemptId: z.string().optional(),
});
export type TeamScope = z.infer<typeof TeamScopeSchema>;
export function teamScopePath(sessionId?: string): string {
    const supplied = process.env.VH_TEAM_SCOPE_FILE;
    if (supplied) {
        if (!isAbsolute(supplied)) throw new Error('VH_TEAM_SCOPE_FILE must be absolute');
        return supplied;
    }
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Teams requires a managed session or VH_TEAM_SCOPE_FILE');
    return join(configuration.happyHomeDir, 'teams', 'scopes', `${sessionId}.json`);
}
export async function readTeamScope(path: string): Promise<TeamScope | null> {
    let file;
    try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw new Error('Cannot open team scope'); }
    try {
        const stat = await file.stat();
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Team scope owner mismatch');
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Team scope must be a private 0600 file');
        const scope = TeamScopeSchema.parse(JSON.parse(await file.readFile('utf8')));
        scope.serverUrl = normalizeHttpEndpoint(scope.serverUrl, 'team scope');
        if (scope.serverUrl !== configuration.serverUrl) throw new Error('Team scope belongs to another server');
        return scope;
    } catch { throw new Error('Invalid or unsafe team scope file'); }
    finally { await file.close(); }
}
export async function writeTeamScope(path: string, scope: TeamScope): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.new`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(TeamScopeSchema.parse(scope))); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}
