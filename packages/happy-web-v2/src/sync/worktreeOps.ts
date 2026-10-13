/**
 * B-585/B-586 machine RPC wrappers for `worktree-*`. Iron rule 17: a resolved
 * RPC may still be `{ error }` (an old daemon answers `Method not found`), so
 * every wrapper checks `error` before reading the payload and reports
 * `unsupported` separately so the UI can say "update the CLI".
 */
import { apiSocket } from './apiSocket';
import { isUnsupportedRpcError, type WorktreeSetupState } from '@/utils/worktree';

export type WorktreeRpcResult<T> = { ok: true; data: T } | { ok: false; error: string; unsupported: boolean };

export interface WorktreeInfo {
    repoRoot: string;
    currentBranch: string | null;
    branches: string[];
    defaultParent: string;
    config: { source: 'file' | 'default' | 'none' | 'invalid'; copy: string[]; link: string[]; hasSetup: boolean; setupApproved: boolean; error?: string };
}

export interface SkippedPath { path: string; reason: string }

export interface WorktreeSetupRecord {
    state: WorktreeSetupState | string;
    hash?: string;
    runner?: string;
    runId?: string;
    startedAt?: number;
    endedAt?: number;
    exitCode?: number | null;
    message?: string;
}

export interface WorktreeCreateResult {
    worktreePath: string;
    branch: string;
    baseRef: string;
    init: { copied: string[]; linked: string[]; skipped: SkippedPath[]; configError?: string; setup: { state: WorktreeSetupState | string; message?: string } };
}

export interface WorktreePendingSetup {
    script: string;
    hash: string;
    runner: string;
    runnerLabel: string;
    cwd: string;
    repoRoot: string;
    configPath: string;
    timeoutMinutes: number;
    changedSinceApproval: boolean;
}

export type WorktreeSetupStatus =
    | { tracked: false }
    | {
        tracked: true;
        worktreePath: string;
        origin: string;
        branch: string | null;
        repoRoot: string;
        copied: string[];
        linked: string[];
        skipped: SkippedPath[];
        configError?: string;
        setup: WorktreeSetupRecord;
        pending?: WorktreePendingSetup;
    };

export interface WorktreeLogChunk { text: string; offset: number; size: number; done: boolean }

export interface WorktreeInspection { removable: boolean; reason?: string; branch: string | null; dirty: string[]; dirtyCount: number }

async function call<T>(machineId: string, method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<WorktreeRpcResult<T>> {
    try {
        const raw = await apiSocket.machineRPC<unknown, Record<string, unknown>>(machineId, method, params, { timeoutMs });
        const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
        if (!obj) return { ok: false, error: 'Empty response', unsupported: false };
        if (typeof obj.error === 'string' && obj.error) return { ok: false, error: obj.error, unsupported: isUnsupportedRpcError(obj.error) };
        return { ok: true, data: obj as T };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, unsupported: isUnsupportedRpcError(message) };
    }
}

export const worktreeInfo = (machineId: string, path: string) => call<WorktreeInfo>(machineId, 'worktree-info', { path });
export const worktreeCreate = (machineId: string, params: { path: string; branch: string; baseRef: string; location: string }) =>
    call<WorktreeCreateResult>(machineId, 'worktree-create', params);
export const worktreeSetupStatus = (machineId: string, path: string) => call<WorktreeSetupStatus>(machineId, 'worktree-setup-status', { path });
export const worktreeSetupApprove = (machineId: string, path: string, hash: string) => call<WorktreeSetupStatus>(machineId, 'worktree-setup-approve', { path, hash });
export const worktreeSetupDecline = (machineId: string, path: string) => call<WorktreeSetupStatus>(machineId, 'worktree-setup-decline', { path });
export const worktreeSetupLog = (machineId: string, path: string, offset: number) => call<WorktreeLogChunk>(machineId, 'worktree-setup-log', { path, offset });
export const worktreeInspect = (machineId: string, path: string) => call<WorktreeInspection>(machineId, 'worktree-inspect', { path });
export const worktreeRemove = (machineId: string, path: string, discardChanges: boolean) =>
    call<{ removed: boolean; branch: string | null }>(machineId, 'worktree-remove', { path, discardChanges });
