import type { RewindTarget } from './messageActionsModel';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/sync/ops';

type RewindDependencies = {
    rpc: (machineId: string, method: string, args: Record<string, string>) => Promise<unknown>;
    rememberMode: (sessionId: string, mode: string) => void;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
};
/** Separate RPC names ensure old daemons cannot silently ignore before semantics. */
export async function createRewindBranch(target: RewindTarget, permissionMode: string | undefined, deps: RewindDependencies): Promise<string> {
    const { source, pointId, messageId } = target;
    const claude = source.kind === 'claude';
    const response = await deps.rpc(source.machineId, claude ? 'claude-rewind-before-message' : 'codex-rewind-before-message', {
        directory: source.directory,
        ...(source.kind === 'claude'
            ? { claudeSessionId: source.claudeSessionId, cutBeforeUuid: pointId }
            : { codexThreadId: source.codexThreadId, cutBeforeItemId: pointId }),
    });
    const result = response as { type?: string; error?: string; errorMessage?: string; startFresh?: boolean; newClaudeSessionId?: string; newCodexThreadId?: string } | null;
    if (!result || result.error || result.type !== 'success') throw new Error(result?.error || result?.errorMessage || 'Invalid rewind response');
    const resumeId = claude ? result.newClaudeSessionId : result.newCodexThreadId;
    if (result.startFresh !== true && (typeof resumeId !== 'string' || !resumeId.trim())) throw new Error('Missing branch identifier');
    const spawned = await deps.spawn({
        machineId: source.machineId, directory: source.directory, agent: source.kind,
        approvedNewDirectoryCreation: false, parentSessionId: source.sessionId, forkedFromMessageId: messageId,
        ...(permissionMode ? { permissionMode } : {}),
        ...(result.startFresh === true ? {} : claude ? { resumeClaudeSessionId: resumeId } : { resumeCodexThreadId: resumeId }),
    });
    if ('error' in spawned || spawned.type !== 'success' || !spawned.sessionId) {
        throw new Error(spawned.type === 'error' ? spawned.errorMessage : 'Branch was not started');
    }
    if (permissionMode) deps.rememberMode(spawned.sessionId, permissionMode);
    return spawned.sessionId;
}
