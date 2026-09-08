/**
 * T-014: the visible side of an RPC rate refusal. apiSocket's RpcRateGate
 * announces each NEW closed window once; this turns it into one toast and one
 * console line. Lives outside apiSocket.ts on purpose — `@/text` and `@/ui`
 * pull localStorage-backed settings into the import chain, which would break
 * every node test that imports apiSocket (see todoFailure.ts for the same
 * split).
 */
import { apiSocket } from './apiSocket';
import { toast } from '@/ui/Toast';
import { t } from '@/text';

export function installRpcRateLimitNotice(): void {
    apiSocket.rpcGate.setOnLimited(({ waitMs, route, attempt, serverError }) => {
        const seconds = Math.max(1, Math.round(waitMs / 1000));
        toast.show(t('rpc.rateLimited', { seconds }), 'info');
        console.warn(`[rpc] ${serverError} on ${route} (refusal #${attempt}); holding RPC for ${waitMs}ms`);
    });
}
