import type { RewindTarget } from './messageActionsModel';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/sync/ops';
import type { ForkSource } from '@/utils/sessionFork';

type RewindDependencies = {
    rpc: (machineId: string, method: string, args: Record<string, string>) => Promise<unknown>;
    rememberMode: (sessionId: string, mode: string) => void;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
};
type BranchResponse = { type?: string; error?: string; errorMessage?: string; startFresh?: boolean; newClaudeSessionId?: string; newCodexThreadId?: string } | null;

/** Separate RPC names ensure old daemons cannot silently ignore before semantics. */
export async function createRewindBranch(target: RewindTarget & { pointId: string }, permissionMode: string | undefined, deps: RewindDependencies): Promise<string> {
    const { source, pointId, messageId } = target;
    const claude = source.kind === 'claude';
    const response = await deps.rpc(source.machineId, claude ? 'claude-rewind-before-message' : 'codex-rewind-before-message', {
        directory: source.directory,
        ...(source.kind === 'claude'
            ? { claudeSessionId: source.claudeSessionId, cutBeforeUuid: pointId }
            : { codexThreadId: source.codexThreadId, cutBeforeItemId: pointId }),
    });
    return spawnBranch(source, response as BranchResponse, permissionMode, messageId, deps);
}

/**
 * B-851: fork the whole conversation — the machine copies the Claude JSONL
 * (`claude-fork-session`) or forks the Codex thread (`codex-fork-thread`),
 * then a new session resumes the copy. The source is never modified.
 */
export async function createSessionFork(source: ForkSource, permissionMode: string | undefined, deps: RewindDependencies): Promise<string> {
    const response = await deps.rpc(source.machineId, source.kind === 'claude' ? 'claude-fork-session' : 'codex-fork-thread', {
        directory: source.directory,
        ...(source.kind === 'claude' ? { claudeSessionId: source.claudeSessionId } : { codexThreadId: source.codexThreadId }),
    });
    const result = response as BranchResponse;
    // A whole-session copy always has something to resume.
    if (result?.startFresh === true) throw new Error('Invalid fork response');
    return spawnBranch(source, result, permissionMode, undefined, deps);
}

async function spawnBranch(source: ForkSource, result: BranchResponse, permissionMode: string | undefined, messageId: string | undefined, deps: RewindDependencies): Promise<string> {
    const claude = source.kind === 'claude';
    if (!result || result.error || result.type !== 'success') throw new Error(result?.error || result?.errorMessage || 'Invalid rewind response');
    const resumeId = claude ? result.newClaudeSessionId : result.newCodexThreadId;
    if (result.startFresh !== true && (typeof resumeId !== 'string' || !resumeId.trim())) throw new Error('Missing branch identifier');
    const spawned = await deps.spawn({
        source: 'fork', machineId: source.machineId, directory: source.directory, agent: source.kind,
        approvedNewDirectoryCreation: false, parentSessionId: source.sessionId,
        ...(messageId ? { forkedFromMessageId: messageId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(result.startFresh === true ? {} : claude ? { resumeClaudeSessionId: resumeId } : { resumeCodexThreadId: resumeId }),
    });
    if ('error' in spawned || spawned.type !== 'success' || !spawned.sessionId) {
        throw new Error(spawned.type === 'error' ? spawned.errorMessage : 'Branch was not started');
    }
    if (permissionMode) deps.rememberMode(spawned.sessionId, permissionMode);
    return spawned.sessionId;
}
