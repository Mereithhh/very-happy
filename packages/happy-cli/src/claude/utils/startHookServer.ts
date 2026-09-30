/**
 * Dedicated HTTP server for receiving Claude session hooks
 * 
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 * 
 * Separate from the MCP server to keep concerns isolated.
 * 
 * ## Control Flow
 * 
 * ### Startup
 * ```
 * runClaude.ts                                  
 *     │                                         
 *     ├─► startHookServer() ──► HTTP server on random port (e.g., 52290)
 *     │                                         
 *     ├─► generateHookSettingsFile(port) ──► ~/.happy/tmp/hooks/session-hook-<pid>.json
 *     │   (contains SessionStart hook pointing to our server)
 *     │                                         
 *     └─► loop() ──► claudeLocal/claudeRemote
 *             │
 *             └─► spawn claude --settings <hook-settings-path>
 * ```
 * 
 * ### Session Notification Flow
 * ```
 * Claude CLI (SessionStart event)
 *     │
 *     ├─► Reads hooks from --settings file
 *     │
 *     └─► Executes hook command (session_hook_forwarder.cjs)
 *             │
 *             ├─► Receives session data on stdin
 *             │
 *             └─► HTTP POST to http://127.0.0.1:<port>/hook/session-start
 *                     │
 *                     └─► startHookServer receives it
 *                             │
 *                             └─► onSessionHook(sessionId, data)
 *                                     │
 *                                     ├─► Updates Session.sessionId
 *                                     ├─► Updates API metadata
 *                                     └─► Notifies SessionScanner
 * ```
 * 
 * ### Triggered By
 * - `happy` (fresh start) - new session created
 * - `happy --continue` - continues last session (may fork)
 * - `happy --resume` - interactive picker, then resume
 * - `happy --resume <id>` - resume specific session
 * - `/compact` command - compacts and forks session
 * - Double-escape fork - user forks conversation in CLI
 * 
 * ### Why Not Use File Watching?
 * File watching has race conditions when multiple Happy processes run.
 * With hooks, Claude directly tells THIS specific process about its session,
 * ensuring 1:1 mapping between Happy process and Claude session.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { logger } from '@/ui/logger';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

/** Transport-level facts about a hook request (not from the hook body). */
export interface SessionHookMeta {
    /**
     * `?source=` of the forwarder that posted it — set only by a tagged hook
     * settings file (B-515: a prewarmed Claude process). Absent for the
     * ordinary per-process settings file.
     */
    source?: string;
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData, meta: SessionHookMeta) => void;
}

/** Parse the hook request target; null when it is not the session-start route. */
export function parseSessionHookTarget(url: string | undefined): SessionHookMeta | null {
    if (!url) return null;
    let parsed: URL;
    try {
        parsed = new URL(url, 'http://127.0.0.1');
    } catch {
        return null;
    }
    if (parsed.pathname !== '/hook/session-start') return null;
    const source = parsed.searchParams.get('source');
    return source && /^[A-Za-z0-9_.-]{1,64}$/.test(source) ? { source } : {};
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
}

export function hookRequestLogMetadata(body: string, data?: SessionHookData): {
    bodyBytes: number;
    parsed: boolean;
    hasSessionId: boolean;
} {
    return {
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        parsed: data !== undefined,
        hasSessionId: Boolean(data?.session_id || data?.sessionId),
    };
}

function hookErrorLogMetadata(error: unknown): { errorType: string; code?: string | number } {
    if (!error || typeof error !== 'object') return { errorType: typeof error };
    const value = error as { name?: unknown; code?: unknown };
    const errorType = typeof value.name === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(value.name)
        ? value.name
        : 'Error';
    const safeCode = typeof value.code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value.code)
        ? value.code
        : typeof value.code === 'number'
            ? value.code
            : undefined;
    return {
        errorType,
        ...(safeCode === undefined ? {} : { code: safeCode }),
    };
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 * 
 * @param options - Server options including the session hook callback
 * @returns Promise resolving to the server instance with port info
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook } = options;

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Only handle POST to /hook/session-start
            const hookMeta = req.method === 'POST' ? parseSessionHookTarget(req.url) : null;
            if (hookMeta) {
                // Set timeout to prevent hanging if Claude doesn't close stdin
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408).end('timeout');
                    }
                }, 5000);

                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    clearTimeout(timeout);
                    
                    const body = Buffer.concat(chunks).toString('utf-8');

                    let data: SessionHookData | undefined;
                    try {
                        data = JSON.parse(body);
                        logger.debug('[hookServer] Received session hook metadata', hookRequestLogMetadata(body, data));
                    } catch {
                        logger.debug('[hookServer] Failed to parse session hook', hookRequestLogMetadata(body));
                    }

                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = data?.session_id || data?.sessionId;
                    if (sessionId && data) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, data, hookMeta);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                } catch (error) {
                    clearTimeout(timeout);
                    logger.debug('[hookServer] Error handling session hook', hookErrorLogMetadata(error));
                    if (!res.headersSent) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            // 404 for anything else
            res.writeHead(404).end('not found');
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error', hookErrorLogMetadata(err));
            reject(err);
        });
    });
}
