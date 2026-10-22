import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt, receiptPath } from './journal';

/**
 * B-730 (`specs/2026-10-team-scope-reattach.md`): a team wrapper's scope lives
 * only in its spawn env (VH_TEAM_SCOPE_FILE / VH_TEAM_OPERATION_ID). Restart,
 * resume, offline recovery and automation wake used to relaunch it without
 * them, so the session silently became "not in a team" and created its own
 * team. Every relaunch now re-derives the env from the session.
 */
const OPERATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function teamScopeFilePath(home: string, operationId: string): string {
    if (!OPERATION_ID.test(operationId)) throw new Error('Invalid team operation id');
    return join(home, 'teams', 'scopes', `${operationId}.json`);
}

/** The team launch behind this session: its metadata, else this machine's newest spawn receipt for it. */
export function relaunchTeamOperationId(home: string, sessionId: string, metadata: { teamOperationId?: unknown } | undefined): string | null {
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
    log: (message: string) => void;
}): Promise<Record<string, string>> {
    const operationId = relaunchTeamOperationId(input.home, input.sessionId, input.metadata);
    if (!operationId) return {};
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
