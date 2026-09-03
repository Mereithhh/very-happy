/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { SPAWN_AGENTS } from '@/utils/spawnAgents';
import type { AssistantReportEvent } from './assistantReport';
import { isAuthorizedDaemonControlRequest } from './controlAuth';

export function startDaemonControlServer({
  controlToken,
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook,
  onSessionStateEvent,
  onClaudeAuthFailed,
  pushClipboard,
  onTerminalHook,
  setTerminalTitle
}: {
  /** Fresh per-process bearer token persisted in the private daemon state. */
  controlToken: string;
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
  /** B-069: a session reported a stable state transition (turn done /
   *  blocked on permission). Optional so older wirings/tests keep working. */
  onSessionStateEvent?: (sessionId: string, event: AssistantReportEvent, spawnedBy?: string) => void;
  /** B-276: a session's Claude Code turn ended with `authentication_failed`. */
  onClaudeAuthFailed?: (sessionId: string) => void;
  pushClipboard: (text: string) => { delivered: boolean; truncated: boolean; totalBytes: number; error?: string };
  /** B-105: a claude SessionStart/SessionEnd hook forwarded from inside a vh
   *  web terminal (scripts/terminal_mirror_forwarder.cjs). Payload is claude's
   *  hook JSON + terminalId; parsing/validation is the mirror manager's job.
   *  Optional so older wirings/tests keep working. */
  onTerminalHook?: (body: unknown) => void;
  /** Title a vh web terminal (tmux `@vh_title`) from a local process inside
   *  it (`very-happy mcp` change_title with VH_TERMINAL_ID). Same tmux result
   *  contract as the `set-terminal-title` machine RPC: false = not landed.
   *  Optional so older wirings/tests keep working (→ 503). */
  setTerminalTitle?: (terminalId: string, title: string, ifAbsent: boolean) => boolean;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Loopback is not an authentication boundary: another local process (or a
    // browser coerced into talking to localhost) can reach this port. Apply one
    // fail-closed gate before every control route, including lifecycle hooks.
    app.addHook('onRequest', async (request, reply) => {
      if (!isAuthorizedDaemonControlRequest(request.headers.authorization, controlToken)) {
        await reply
          .code(401)
          .header('WWW-Authenticate', 'Bearer')
          .send({ error: 'Unauthorized' });
      }
    });

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any(),
          encryption: z.object({
            encryptionKey: z.string(),
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: z.number(),
            metadataVersion: z.number(),
            agentStateVersion: z.number(),
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onHappySessionWebhook(sessionId, metadata, encryptionData);

      return { status: 'ok' as const };
    });

    // B-069: a session reports a stable agent-state transition (turn finished
    // and idle → 'completed', blocked on a permission request → 'needs_input').
    // The session-side emitter only fires when HAPPY_SPAWNED_BY is set, and it
    // echoes that tag so the sink survives a daemon restart (which loses the
    // in-memory TrackedSession.spawnedBy). Best-effort: always 200.
    typed.post('/session-event', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          event: z.enum(['completed', 'needs_input', 'auth_failed']),
          spawnedBy: z.string().optional(),
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, event, spawnedBy } = request.body;
      logger.debug(`[CONTROL SERVER] Session event: ${sessionId} ${event} (spawnedBy=${spawnedBy ?? 'unset'})`);
      if (event === 'auth_failed') {
        // B-276: never route into the assistant-report sink (its vocabulary is
        // completed/needs_input); this only re-arms the auth preflight.
        onClaudeAuthFailed?.(sessionId);
        return { status: 'ok' as const };
      }
      onSessionStateEvent?.(sessionId, event, spawnedBy);
      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          // Optional-with-default (not plain optional): the assistant variant
          // ignores it and supplies its own home daemon-side.
          directory: z.string().default(''),
          sessionId: z.string().optional(),
          agent: z.enum(SPAWN_AGENTS).optional(),
          environmentVariables: z.record(z.string(), z.string()).optional(),
          variant: z.enum(['assistant']).optional(),
          // B-051: assistant only — stop the live assistant, purge its
          // persisted entry, and spawn brand-new instead of re-attaching.
          forceNew: z.boolean().optional(),
          // Forwarded to the spawned CLI as `--permission-mode <v>` after
          // daemon-side allowlist validation (invalid values are ignored).
          permissionMode: z.string().optional(),
          // B-069: spawn-origin tag ('assistant' = session_spawn). Recorded on
          // the TrackedSession; old clients never send it.
          spawnedBy: z.string().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables, variant, forceNew, permissionMode, spawnedBy } = request.body;

      if (!directory && variant !== 'assistant') {
        reply.code(500);
        return { success: false, error: 'directory is required' };
      }

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}, variant=${variant || 'none'}, forceNew=${forceNew === true}, spawnedBy=${spawnedBy || 'unset'}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables, variant, forceNew, permissionMode, spawnedBy });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // B-105: terminal mirror hook ingress. The forwarder script fires this for
    // claude SessionStart/SessionEnd inside vh web terminals; payload shape is
    // claude's (unversioned) hook JSON, so keep the schema loose and always
    // 200 — a hook must never observe an error it could surface into claude.
    typed.post('/terminal-hook', {
      schema: {
        body: z.any(),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      try {
        onTerminalHook?.(request.body);
      } catch (error) {
        logger.debug('[CONTROL SERVER] terminal-hook handler failed:', error);
      }
      return { status: 'ok' as const };
    });

    // Push text to the clipboard of the user's open web clients.
    // Local IPC for the `very-happy mcp` stdio server (registered into the
    // real claude CLI running in a web terminal): the daemon relays the text
    // over its authenticated machine socket, encrypted with the machine key.
    typed.post('/clipboard', {
      schema: {
        body: z.object({
          text: z.string()
        }),
        response: {
          200: z.object({
            delivered: z.boolean(),
            truncated: z.boolean(),
            totalBytes: z.number(),
            error: z.string().optional()
          })
        }
      }
    }, async (request) => {
      const { text } = request.body;
      logger.debug(`[CONTROL SERVER] Clipboard push request (${text.length} chars)`);
      return pushClipboard(text);
    });

    // Title a web terminal from a process running inside it. Local IPC for
    // `very-happy mcp` change_title (VH_TERMINAL_ID context): the daemon owns
    // the tmux session, so it is the only place the title can be persisted.
    typed.post('/terminal-title', {
      schema: {
        body: z.object({
          terminalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          title: z.string().min(1).max(200),
          ifAbsent: z.boolean().optional()
        }),
        response: {
          200: z.object({ status: z.literal('ok') }),
          409: z.object({ error: z.string() }),
          503: z.object({ error: z.string() })
        }
      }
    }, async (request, reply) => {
      const { terminalId, title, ifAbsent } = request.body;
      if (!setTerminalTitle) {
        return reply.code(503).send({ error: 'daemon is still starting up' });
      }
      if (!setTerminalTitle(terminalId, title, !!ifAbsent)) {
        return reply.code(409).send({ error: 'Failed to set terminal title (tmux unavailable or terminal gone)' });
      }
      return { status: 'ok' as const };
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
