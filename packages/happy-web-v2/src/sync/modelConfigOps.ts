/**
 * B-688 machine RPC wrappers for `model-config-*`. Iron rule 17: a resolved
 * RPC may still be `{ error }` (an old daemon answers `Method not found`), so
 * every call checks `error` first and reports `unsupported` separately so the
 * UI can say "update the CLI". The apiKey travels only inside the
 * machine-key-encrypted params of `model-config-apply`; nothing here logs it.
 */
import { apiSocket } from './apiSocket';
import { isUnsupportedRpcError } from '@/utils/worktree';
import type { HarnessId, ModelConfigApplyResult, ModelConfigPatch, ModelConfigReadResult } from './modelConfigTypes';

export type ModelConfigRpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; unsupported: boolean };

async function call<T>(machineId: string, method: string, params: Record<string, unknown>): Promise<ModelConfigRpcResult<T>> {
    try {
        const raw = await apiSocket.machineRPC<unknown, Record<string, unknown>>(machineId, method, params, { timeoutMs: 30_000 });
        const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
        if (!obj) return { ok: false, error: 'Empty response', unsupported: false };
        if (typeof obj.error === 'string' && obj.error) {
            return { ok: false, error: obj.error, code: typeof obj.code === 'string' ? obj.code : undefined, unsupported: isUnsupportedRpcError(obj.error) };
        }
        return { ok: true, data: obj as T };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message, unsupported: isUnsupportedRpcError(message) };
    }
}

export const modelConfigRead = (machineId: string, params: { harness?: HarnessId; providerId?: string } = {}) =>
    call<ModelConfigReadResult>(machineId, 'model-config-read', params);

/** dryRun (default) returns the masked diff; a real write needs the preview's baseHash. */
export const modelConfigApply = (machineId: string, patch: ModelConfigPatch, opts: { dryRun: true } | { dryRun: false; baseHash: string }) =>
    call<ModelConfigApplyResult>(machineId, 'model-config-apply', { patch, ...opts });

export const modelConfigRestore = (machineId: string, harness: HarnessId, backupId: string, opts: { dryRun: true } | { dryRun: false; baseHash: string }) =>
    call<ModelConfigApplyResult>(machineId, 'model-config-restore', { harness, backupId, ...opts });
