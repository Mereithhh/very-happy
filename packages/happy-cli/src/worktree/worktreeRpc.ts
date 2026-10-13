/**
 * B-585/B-586 machine RPCs (`worktree-*`). New methods on purpose — never new
 * spawn fields: an old daemon answers an unknown method with
 * `{error:'Method not found'}`, while it would silently IGNORE a new spawn
 * field and start the session in the base checkout instead of a worktree.
 *
 * Errors are thrown with a stable code (`WorktreeError`); RpcHandlerManager
 * encodes them as a normal `{ error }` response (iron rule 17).
 */
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { WorktreeService } from './service';

export const WORKTREE_RPC_METHODS = [
    'worktree-info',
    'worktree-create',
    'worktree-setup-status',
    'worktree-setup-approve',
    'worktree-setup-decline',
    'worktree-setup-log',
    'worktree-inspect',
    'worktree-remove',
] as const;

/** Machine-metadata capability the web gates the feature on. */
export const WORKTREE_CAPABILITY_VERSION = 1;

type Params = Record<string, unknown>;
const obj = (value: unknown): Params => (value && typeof value === 'object' ? value as Params : {});

export function registerWorktreeHandlers(rpc: RpcHandlerManager, service: WorktreeService): void {
    rpc.registerHandler('worktree-info', async (params: unknown) => service.info(obj(params).path as string));
    rpc.registerHandler('worktree-create', async (params: unknown) => {
        const p = obj(params);
        return service.create({ path: p.path, branch: p.branch, baseRef: p.baseRef, location: p.location });
    });
    rpc.registerHandler('worktree-setup-status', async (params: unknown) => service.status(obj(params).path));
    rpc.registerHandler('worktree-setup-approve', async (params: unknown) => service.approve(obj(params).path, obj(params).hash));
    rpc.registerHandler('worktree-setup-decline', async (params: unknown) => service.decline(obj(params).path));
    rpc.registerHandler('worktree-setup-log', async (params: unknown) => service.log(obj(params).path, obj(params).offset));
    rpc.registerHandler('worktree-inspect', async (params: unknown) => service.inspect(obj(params).path));
    rpc.registerHandler('worktree-remove', async (params: unknown) => service.remove(obj(params).path, obj(params).discardChanges));
}
