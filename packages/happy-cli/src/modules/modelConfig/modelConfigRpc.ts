/**
 * B-688 machine RPCs `model-config-read` / `model-config-apply` /
 * `model-config-restore` (spec specs/2026-10-custom-models.md). New methods,
 * gated on machine metadata `modelConfigVersion`: an old daemon answers
 * `Method not found`, which the web turns into "update the CLI".
 *
 * Params arrive machine-key encrypted and are never logged (RpcHandlerManager
 * logs method names only). Failures come back as `{ error, code }` — a normal
 * response per iron rule 17 — with messages that never interpolate a value.
 */
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ModelConfigError } from './fileStore';
import type { ModelConfigService } from './service';

type Params = Record<string, unknown>;
const obj = (value: unknown): Params => (value && typeof value === 'object' ? value as Params : {});

async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string; code: string }> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof ModelConfigError) return { error: error.message, code: error.code };
        // Unexpected (fs) errors: code only + a generic message; fs messages carry paths, never values.
        return { error: error instanceof Error ? error.message : 'Unknown error', code: 'internal' };
    }
}

export function registerModelConfigHandlers(rpc: RpcHandlerManager, service: ModelConfigService): void {
    rpc.registerHandler('model-config-read', (params: unknown) => guarded(() => service.read(obj(params))));
    rpc.registerHandler('model-config-apply', (params: unknown) => guarded(() => service.apply(obj(params))));
    rpc.registerHandler('model-config-restore', (params: unknown) => guarded(() => service.restore(obj(params))));
}
