import { logger } from "@/ui/logger";
import { claudeLocal, ExitCodeError } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { describeClaudeProcessExit } from "./claudeProcessExit";

export type LauncherResult = { type: 'switch' } | { type: 'exit', code: number };

export async function claudeLocalLauncher(session: Session): Promise<LauncherResult> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        // B-551: prefer the transcript path Claude reported via its hook.
        transcriptPathHints: session.transcriptPathHints ?? undefined,
        onMessage: (message) => { 
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }
        }
    });
    
    // Register callback to notify scanner when session ID is found via hook
    // This is important for --continue/--resume where session ID is not known upfront
    const scannerSessionCallback = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(scannerSessionCallback);


    // Handle abort
    let exitReason: LauncherResult | null = null;
    let switchRequested = false;
    const processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exutFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');
            session.onAbort();

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }

            session.client.closeClaudeSessionTurn('cancelled');

            // Reset sent messages
            session.queue.reset();

            // Abort
            await abort();
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');
            switchRequested = true;
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
        }

        // When to abort
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Abort current process, clean queue and switch to remote mode
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When user wants to switch to remote mode
        session.queue.setOnMessage((_message: string, _mode) => {
            // Remote messages request control from the app. Stop local Claude
            // so queued app messages can be picked up by remote mode now.
            void doSwitch();
        });

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return { type: 'switch' };
        }

        // Handle session start
        const handleSessionStart = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionStart,
                    onThinkingChange: session.onThinkingChange,
                    abort: processAbortController.signal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                    sandboxConfig: session.sandboxConfig,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // Normal exit
                if (!exitReason) {
                    session.client.closeClaudeSessionTurn('completed');
                    exitReason = (switchRequested || session.queue.size() > 0)
                        ? { type: 'switch' }
                        : { type: 'exit', code: 0 };
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                // If Claude exited with non-zero exit code, propagate it
                if (e instanceof ExitCodeError) {
                    if (exitReason) {
                        break; // preserve existing exit reason (e.g. switch intent) — SIGTERM is expected
                    }
                    // B-631: the exit code travels with the turn-end and as a
                    // visible line (local mode inherits stderr, so no tail).
                    const exit = describeClaudeProcessExit(e);
                    session.client.closeClaudeSessionTurn('failed', { error: exit });
                    session.client.sendSessionEvent({ type: 'message', message: exit, kind: 'claude-process-exit' });
                    exitReason = (switchRequested || session.queue.size() > 0)
                        ? { type: 'switch' }
                        : { type: 'exit', code: e.exitCode };
                    break;
                }
                if (!exitReason) {
                    session.client.sendSessionEvent({ type: 'message', message: describeClaudeProcessExit(e), kind: 'claude-process-exit' });
                    continue;
                } else {
                    break;
                }
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exutFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.queue.setOnMessage(null);
        
        // Remove session found callback
        session.removeSessionFoundCallback(scannerSessionCallback);

        // Cleanup
        await scanner.cleanup();
    }

    // Return
    return exitReason || { type: 'exit', code: 0 };
}
