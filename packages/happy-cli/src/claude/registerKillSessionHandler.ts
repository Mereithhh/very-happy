import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}

interface SessionArchiveEvents {
    on(event: 'archived', listener: () => void): unknown;
}


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    killThisHappy: () => Promise<void>,
    archiveEvents: SessionArchiveEvents,
) {
    let terminationStarted = false;
    const terminateOnce = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        void killThisHappy();
    };

    // The server-owned archive event is the primary path. Keeping it beside
    // the legacy RPC registration guarantees every runner (not only Claude)
    // obeys the same lifecycle command, including a directly launched CLI
    // whose machine daemon is unavailable.
    archiveEvents.on('archived', terminateOnce);

    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>('killSession', async () => {
        logger.debug('Kill session request received');

        // This will start the cleanup process
        terminateOnce();

        // We should still be able to respond the the client, though they
        // should optimistically assume the session is dead.
        return {
            success: true,
            message: 'Killing happy-cli process'
        };
    });
}
