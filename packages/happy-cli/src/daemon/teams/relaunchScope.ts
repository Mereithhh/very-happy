import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamState } from '@slopus/happy-wire';
import { teamExitMarkerPath, type TeamExitMarker } from '@/teams/exitNotice';
import { detectTeamUserLanguage, teamOwnerText } from '@/teams/language';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { readReceipt, receiptPath, type TeamEffectReceipt } from './journal';

export { teamExitMarkerPath };

/**
 * B-730 (`specs/2026-10-team-scope-reattach.md`): a team wrapper's scope lives
 * only in its spawn env (VH_TEAM_SCOPE_FILE / VH_TEAM_OPERATION_ID). Restart,
 * resume, offline recovery and automation wake used to relaunch it without
 * them, so the session silently became "not in a team" and created its own
 * team. Every relaunch now re-derives the env from the session.
 */
const OPERATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** B-877: the exit marker is set by 「退出团队模式」 (exitTeamMode.ts); this machine relaunches the session as an ordinary one. */
export function hasExitedTeamMode(home: string, sessionId: string): boolean {
    try { return existsSync(teamExitMarkerPath(home, sessionId)); } catch { return false; }
}

export function teamScopeFilePath(home: string, operationId: string): string {
    if (!OPERATION_ID.test(operationId)) throw new Error('Invalid team operation id');
    return join(home, 'teams', 'scopes', `${operationId}.json`);
}

/** B-962: 「恢复团队」 continued this session under a new launch; its relaunches use that launch (the session metadata still names the first one). */
export function teamRestorePointerPath(home: string, sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session id');
    return join(home, 'teams', 'restored', `${sessionId}.json`);
}
export function writeTeamRestorePointer(home: string, sessionId: string, operationId: string): void {
    ensurePrivateDirectorySync(join(home, 'teams', 'restored'));
    writePrivateFileSync(teamRestorePointerPath(home, sessionId), JSON.stringify({ operationId, at: Date.now() }));
}
function restoredOperationId(home: string, sessionId: string): string | null {
    try {
        const value = JSON.parse(readFileSync(teamRestorePointerPath(home, sessionId), 'utf8'))?.operationId;
        return typeof value === 'string' && OPERATION_ID.test(value) ? value : null;
    } catch { return null; }
}

/**
 * B-962: the newest spawn receipt of this machine that ran `sessionId` with a worktree — where a restored
 * member continues (the original launch's worktree, repository and branch; its cleanup finds them here).
 */
export function sessionLaunchReceipt(home: string, sessionId: string): TeamEffectReceipt | null {
    let names: string[];
    try { names = readdirSync(join(home, 'teams', 'effects')); } catch { return null; }
    let newest: { receipt: TeamEffectReceipt; at: number } | null = null;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!OPERATION_ID.test(id)) continue;
        try {
            const receipt = readReceipt(home, id);
            if (receipt?.sessionId !== sessionId || !receipt.directory || !receipt.repository || !receipt.branch) continue;
            const at = statSync(receiptPath(home, id)).mtimeMs;
            if (!newest || at > newest.at) newest = { receipt, at };
        } catch { /* a corrupt receipt is never evidence */ }
    }
    return newest?.receipt ?? null;
}

/** The team launch behind this session: a restore's (B-962), its metadata, else this machine's newest spawn receipt for it. */
export function relaunchTeamOperationId(home: string, sessionId: string, metadata: { teamOperationId?: unknown } | undefined): string | null {
    const restored = restoredOperationId(home, sessionId);
    if (restored) return restored;
    const fromMetadata = metadata?.teamOperationId;
    if (typeof fromMetadata === 'string' && OPERATION_ID.test(fromMetadata)) return fromMetadata;
    let names: string[];
    try { names = readdirSync(join(home, 'teams', 'effects')); } catch { return null; }
    let newest: { id: string; at: number } | null = null;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!OPERATION_ID.test(id)) continue;
        try {
            const receipt = readReceipt(home, id);
            if (receipt?.sessionId !== sessionId || !receipt.scopeFile) continue;
            const at = statSync(receiptPath(home, id)).mtimeMs;
            if (!newest || at > newest.at) newest = { id, at };
        } catch { /* a corrupt receipt is never evidence of a binding */ }
    }
    return newest?.id ?? null;
}

/** B-877: the marker fields both exit paths share (team name and the owner's language feed the model-facing texts). */
export function teamExitMarker(team: Pick<TeamState, 'id' | 'name' | 'tasks'>, managed: boolean, reason: 'exit' | 'archived'): TeamExitMarker {
    return { teamId: team.id, teamName: team.name, managed, at: Date.now(), language: detectTeamUserLanguage(teamOwnerText(team.tasks)), reason };
}

/**
 * B-877b: the lead of a team archived while it was down (B-730 relaunch path) — the marker that turns
 * it into an ordinary session, or null when the launch belongs to a live team, a member, or nothing.
 */
export function archivedLeadMarker(team: TeamState, operationId: string, sessionId: string): TeamExitMarker | null {
    const op = team.operations.find(candidate => candidate.id === operationId);
    if (team.archivedAt === undefined || op?.type !== 'spawn') return null;
    const bot = team.bots.find(candidate => candidate.id === op.botId);
    return bot?.root && bot.sessionId === sessionId ? teamExitMarker(team, true, 'archived') : null;
}

/** The team of a launch, from this machine's spawn receipt (the owner's team list leaves archived teams out). */
export function launchTeamId(home: string, operationId: string): string | null {
    try { return readReceipt(home, operationId)?.teamId ?? null; } catch { return null; }
}

/**
 * Env that puts a relaunched wrapper back in its team. A missing scope file is
 * rebuilt through `recover` (the owning daemon re-reads its claim); when that
 * fails the env still points at the missing file, so the wrapper refuses team
 * tools with "scope is missing" instead of acting as an unassigned session.
 */
export async function teamRelaunchEnv(input: {
    home: string;
    sessionId: string;
    metadata: { teamOperationId?: unknown } | undefined;
    recover?: (operationId: string, scopeFile: string) => Promise<void>;
    /** B-877b: reads a team as its owner, to find a lead whose team was archived meanwhile (failure = relaunch as before). */
    team?: (teamId: string) => Promise<TeamState>;
    log: (message: string) => void;
}): Promise<Record<string, string>> {
    // B-877: the owner took this session out of its team (「退出团队模式」): relaunch it as an ordinary session.
    if (hasExitedTeamMode(input.home, input.sessionId)) return {};
    const operationId = relaunchTeamOperationId(input.home, input.sessionId, input.metadata);
    if (!operationId) return {};
    // B-877b: a lead whose team is archived goes on as an ordinary session that knows it (exitNotice.ts),
    // instead of a team session whose tools refuse with "no team scope".
    const teamId = launchTeamId(input.home, operationId);
    if (input.team && teamId) {
        try {
            const marker = archivedLeadMarker(await input.team(teamId), operationId, input.sessionId);
            if (marker) {
                ensurePrivateDirectorySync(join(input.home, 'teams', 'exited'));
                writePrivateFileSync(teamExitMarkerPath(input.home, input.sessionId), JSON.stringify(marker));
                input.log(`Team ${marker.teamId} of lead ${input.sessionId} is archived; relaunching it as an ordinary session`);
                return {};
            }
        } catch (error) {
            input.log(`Teams state for ${input.sessionId} unavailable (${error instanceof Error ? error.message : 'unknown error'}); relaunching with its team env`);
        }
    }
    const scopeFile = teamScopeFilePath(input.home, operationId);
    if (!existsSync(scopeFile) && input.recover) {
        try {
            await input.recover(operationId, scopeFile);
            input.log(`Teams scope for ${input.sessionId} rebuilt from operation ${operationId}`);
        } catch (error) {
            input.log(`Teams scope for ${input.sessionId} could not be rebuilt: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
    if (!existsSync(scopeFile)) input.log(`Teams scope for ${input.sessionId} is missing; team tools will refuse until the owner restores it`);
    return { VH_TEAM_SCOPE_FILE: scopeFile, VH_TEAM_OPERATION_ID: operationId, HAPPY_SPAWNED_BY: 'teams' };
}
