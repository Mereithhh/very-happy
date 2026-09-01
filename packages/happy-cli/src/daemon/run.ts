import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { pruneLogsDir } from '@/ui/logPrune';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession, deletePersistedSessions } from '@/persistence';
import type { PersistedSession } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { createSpawnGate, findLiveAssistant, isAssistantTracked, listPersistedAssistantIds, pickLatestAssistantEntry, resolveAssistantClaudeSessionId } from './assistantSpawn';
import { decideAssistantReport, formatAssistantReportMessage, resolveReportSessionTitle, type AssistantReportEvent } from './assistantReport';
import { sendUserMessage } from '@/commands/sessionMessage';
import { sanitizeSpawnPermissionMode } from './spawnPermissionMode';
import { resumePrecheck, sanitizeResumeModel } from './resumePrecheck';
import { decideRestart, recordRestartAttempt, DEFAULT_MAX_RESTARTS } from './restartBreaker';
import type { SpawnGate } from './assistantSpawn';
import { startDaemonControlServer } from './controlServer';
import { assistantHome, bootstrapAssistantHome } from '@/assistant/bootstrap';
import { getProjectPath } from '@/claude/utils/path';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { daemonEndpointsMatch, resolveClaudeCredentialReadiness } from '@/ui/doctorReadiness';
import { summarizeSpawnSessionForLog } from '@/utils/spawnSessionLog';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { encodeBase64, decodeBase64, decrypt } from '@/api/encryption';
import { createMirrorManager, type MirrorManager } from '@/mirror/mirrorManager';
import { createDaemonControlToken } from './controlAuth';
import { withDaemonHeartbeat } from './daemonState';
import { DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS, fetchCliUpdateState, resolveCliUpdateCheckInterval } from '@/update/cliUpdate';
import { terminateProcess } from './processTermination';
import { findAllHappyProcesses } from './doctor';
import { findSessionWrapperPids, mergeRestoreMetadata } from './sessionProcessRecovery';
import { readSessionLock } from '@/utils/sessionLock';

/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
};

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  // Retention sweep: ~/.happy/logs grows unbounded otherwise (746MB found in
  // the field). Age+size capped, own log file protected, never throws.
  const prunedLogs = pruneLogsDir(configuration.logsDir, new Set([logger.logFilePath]));
  if (prunedLogs > 0) {
    logger.debug(`[DAEMON RUN] Pruned ${prunedLogs} old log file(s) from ${configuration.logsDir}`);
  }

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  const runningDaemonState = await readDaemonState();
  const runningDaemonEndpointsMatch = Boolean(runningDaemonState) && daemonEndpointsMatch(
    runningDaemonState?.serverUrl,
    runningDaemonState?.webappUrl,
    configuration.serverUrl,
    configuration.webappUrl,
  );
  if (!runningDaemonVersionMatches || !runningDaemonEndpointsMatch) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd, similar to OpenClaw's model), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon version or endpoint mismatch detected, restarting daemon');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    const liveHappyProcesses = await findAllHappyProcesses();
    for (const [id, s] of Object.entries(persisted)) {
      const tracked: TrackedSession = {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      };
      // B-272: by persisted pid first, then by the daemon-spawned
      // `--resume <id>` command line — the record's hostPid can be stale
      // (see sessionProcessRecovery.ts), which used to orphan a live wrapper
      // and let the next restart-session spawn a second one next to it.
      const livePids = findSessionWrapperPids(s.metadata, liveHappyProcesses, { excludePid: process.pid, lockPid: readSessionLock(id)?.pid });
      if (livePids.length > 0) {
        const [livePid, ...duplicates] = livePids;
        tracked.pid = livePid;
        tracked.startedBy = 'recovered after daemon restart';
        pidToTrackedSession.set(livePid, tracked);
        if (livePid !== s.metadata?.hostPid) {
          logger.debug(`[DAEMON RUN] Session ${id}: persisted hostPid ${s.metadata?.hostPid} is stale; adopted live wrapper ${livePid} by its --resume command line`);
        }
        for (const dup of duplicates) {
          // Two live wrappers on one session = two SDK runs on one conversation.
          // Track the extra under the same session id so restart-session stops
          // ALL of them before relaunching. Never kill here: a wrapper's
          // deactivate archives the row, which takes every sibling down too.
          logger.warn(`[DAEMON RUN] Session ${id} has a duplicate live wrapper ${dup} (kept ${livePid}); restart the session to collapse them`);
          pidToTrackedSession.set(dup, { ...tracked, pid: dup, startedBy: 'recovered after daemon restart (duplicate wrapper)' });
        }
        // B-265: seen alive → the 14-day restore retention restarts from now.
        // B-272: and the record now names the wrapper actually adopted.
        persistSession(id, { ...s, metadata: { ...s.metadata, hostPid: livePid }, savedAt: Date.now() });
      } else {
        sessionIdToFinishedSession.set(id, tracked);
      }
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
        });
      }

      // B-272: two live wrappers on one session are two writers on one
      // conversation. Surface it loudly; restart-session is the collapse path.
      for (const [otherPid, other] of pidToTrackedSession.entries()) {
        if (other.happySessionId === sessionId && otherPid !== pid && isPidAlive(otherPid)) {
          logger.warn(`[DAEMON RUN] Session ${sessionId} now has two live wrappers (${otherPid} and ${pid}); restart the session to collapse them`);
        }
      }

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.encryption = encryption;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // C2a (B-051): serialize assistant spawns — concurrent requests join the
    // same in-flight promise (no double-spawn race); forceNew waits for any
    // in-flight spawn to settle, then replaces it with a fresh run.
    const assistantSpawnGate = createSpawnGate<SpawnSessionResult>();

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      if (options.variant !== 'assistant') {
        return spawnSessionImpl(options);
      }
      return options.forceNew
        ? assistantSpawnGate.replace(() => spawnSessionImpl(options))
        : assistantSpawnGate.join(() => spawnSessionImpl(options));
    };

    const spawnSessionImpl = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', summarizeSpawnSessionForLog(options));

      // Client-requested permission mode (allowlist-validated; used by the
      // assistant "skip permission approvals" setting). Sanitized ONCE here so
      // all three spawn paths (assistant re-attach, tmux, plain) agree; an
      // invalid value is ignored (spawn proceeds without the flag) — old webs
      // never send the field, so behavior is unchanged for them.
      const spawnPermissionMode = sanitizeSpawnPermissionMode(options.permissionMode);
      if (options.permissionMode !== undefined && spawnPermissionMode === null) {
        logger.warn('[DAEMON RUN] Ignoring invalid permissionMode in spawn request');
      }

      // ── B-051 assistant variant ────────────────────────────────────────────
      // The machine's meta-agent session. cwd is FORCED to ~/.happy/assistant
      // (any passed directory is ignored), the home is bootstrapped on first
      // use, and the session is a per-machine singleton (spawn requests are
      // serialized through assistantSpawnGate):
      //   1. a live assistant process → return its session id (no new spawn);
      //   2. a persisted assistant session (sessions.json) → re-attach via
      //      HAPPY_RECONNECT_* so the SAME session row + encryption key are
      //      reused (with dataKey credentials getOrCreateSession mints a fresh
      //      key per launch, so only reconnect can reuse a row cleanly);
      //   3. nothing known → fresh spawn with a random tag = a brand-new
      //      session row and key (nothing can decrypt-mismatch old rows).
      // forceNew skips 1–2: it stops any surviving assistant process, purges
      // the sessions.json entries, and always takes path 3.
      if (options.variant === 'assistant') {
        options = { ...options, directory: assistantHome() };

        if (options.forceNew) {
          // C2c: force-respawn — stop any surviving assistant process and
          // forget the persisted entries so we never re-attach to them.
          for (const tracked of [...pidToTrackedSession.values()]) {
            if (!isAssistantTracked(tracked)) continue;
            logger.debug(`[DAEMON RUN] forceNew: stopping assistant (session ${tracked.happySessionId ?? 'unknown'}, pid ${tracked.pid})`);
            stopSession(tracked.happySessionId ?? `PID-${tracked.pid}`);
          }
          const assistantIds = listPersistedAssistantIds(readPersistedSessions());
          if (assistantIds.length > 0) {
            deletePersistedSessions(assistantIds);
            for (const id of assistantIds) {
              sessionIdToFinishedSession.delete(id);
            }
            logger.debug(`[DAEMON RUN] forceNew: purged persisted assistant session(s): ${assistantIds.join(', ')}`);
          }
        } else {
          // (1) Live singleton: an alive tracked assistant session wins. The
          // spawn-time variant tag (C2b) makes this hold even in the window
          // before the session webhook lands.
          const live = findLiveAssistant(pidToTrackedSession.values(), (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              // stale entry — the heartbeat will prune it
              return false;
            }
          });
          if (live?.happySessionId) {
            logger.debug(`[DAEMON RUN] Assistant already running (session ${live.happySessionId}, pid ${live.pid})`);
            return { type: 'success', sessionId: live.happySessionId };
          }
          if (live) {
            // Alive process whose webhook hasn't arrived yet — never double-spawn.
            return { type: 'error', errorMessage: `Assistant session is still starting (pid ${live.pid}). Try again in a few seconds.` };
          }
        }

        try {
          const { created } = await bootstrapAssistantHome();
          if (created.length > 0) {
            logger.debug(`[DAEMON RUN] Assistant home bootstrapped: ${created.join(', ')}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { type: 'error', errorMessage: `Failed to bootstrap assistant home: ${errorMessage}` };
        }

        // (2) Re-attach to the persisted assistant session with its ORIGINAL
        // encryption key (same mechanism as resume-in-place).
        const assistantEntry = options.forceNew ? undefined : pickLatestAssistantEntry(readPersistedSessions());
        if (assistantEntry) {
          const [assistantSessionId, s] = assistantEntry;
          logger.debug(`[DAEMON RUN] Re-attaching assistant session ${assistantSessionId}`);
          // C3: the sessions.json metadata is a webhook-time snapshot taken
          // BEFORE Claude assigned its conversation id (that later update
          // only reaches the server), so fetch fresh metadata from the
          // server first — same mechanism as resumeSession — and only
          // --resume when the JSONL is actually on disk (a dangling
          // --resume would crash the spawn).
          const serverMetadata = await fetchServerSessionMetadata(
            assistantSessionId,
            decodeBase64(s.encryptionKey),
            s.encryptionVariant,
          );
          const claudeSessionId = resolveAssistantClaudeSessionId(s.metadata, serverMetadata);
          const canResumeClaude = !!claudeSessionId
            && existsSync(join(getProjectPath(assistantHome()), `${claudeSessionId}.jsonl`));
          return spawnTrackedHappyProcess({
            args: [
              'claude',
              '--happy-starting-mode', 'remote',
              '--started-by', 'daemon',
              // Re-attach honors the CURRENT request's permission mode (the
              // user may have just toggled the assistant permission setting).
              ...(spawnPermissionMode ? ['--permission-mode', spawnPermissionMode] : []),
              ...(canResumeClaude ? ['--resume', claudeSessionId!] : []),
            ],
            cwd: assistantHome(),
            env: {
              ...process.env,
              HAPPY_SESSION_VARIANT: 'assistant',
              HAPPY_RECONNECT_SESSION_ID: assistantSessionId,
              HAPPY_RECONNECT_ENCRYPTION_KEY: s.encryptionKey,
              HAPPY_RECONNECT_ENCRYPTION_VARIANT: s.encryptionVariant,
              HAPPY_RECONNECT_SEQ: String(s.seq),
              HAPPY_RECONNECT_METADATA_VERSION: String(s.metadataVersion),
              HAPPY_RECONNECT_AGENT_STATE_VERSION: String(s.agentStateVersion),
            },
            variant: 'assistant',
          });
        }
        // (3) Nothing known locally — fall through to a fresh spawn; the
        // HAPPY_SESSION_VARIANT env is injected via extraEnv below.
      }

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        let extraEnv: Record<string, string> = {
          ...authEnv,
          ...(options.environmentVariables ?? {}),
        };
        if (options.parentSessionId) {
          extraEnv.HAPPY_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.HAPPY_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        // For fork: spawned Happy CLI needs to know which Claude JSONL to
        // backfill into the fresh Happy session row. Without this, the
        // SDK reads the JSONL silently as context but never re-emits the
        // historical messages, so the app shows an empty chat.
        if (options.resumeClaudeSessionId) {
          extraEnv.HAPPY_FORK_CLAUDE_SESSION_ID = options.resumeClaudeSessionId;
        }
        if (options.resumeCodexThreadId) {
          extraEnv.HAPPY_FORK_CODEX_THREAD_ID = options.resumeCodexThreadId;
        }
        // B-051: mark the spawned CLI as the assistant variant (fresh-spawn
        // path; the re-attach path above sets it directly on its env).
        if (options.variant === 'assistant') {
          extraEnv.HAPPY_SESSION_VARIANT = 'assistant';
        }
        // B-069: export the spawn-origin tag so the session process knows to
        // report its stable state transitions back to this daemon
        // (/session-event → assistant 主动汇报 sink).
        if (options.spawnedBy) {
          extraEnv.HAPPY_SPAWNED_BY = options.spawnedBy;
        }
        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : (options.agent === 'openclaw' ? 'openclaw' : 'claude'));
          const resumeId = agent === 'claude'
            ? options.resumeClaudeSessionId
            : (agent === 'codex' ? options.resumeCodexThreadId : undefined);
          const resumeFragment = resumeId
            ? ` --resume ${shellescape(resumeId)}`
            : '';
          const permissionModeFragment = spawnPermissionMode
            ? ` --permission-mode ${shellescape(spawnPermissionMode)}`
            : '';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon${resumeFragment}${permissionModeFragment}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              variant: options.variant,
              spawnedBy: options.spawnedBy,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            case 'openclaw':
              agentCommand = 'openclaw';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          // Resume ids attach the new Happy session to a pre-existing provider
          // conversation created by the fork / duplicate RPC.
          if (options.resumeClaudeSessionId && agentCommand === 'claude') {
            args.push('--resume', options.resumeClaudeSessionId);
          }
          if (options.resumeCodexThreadId && agentCommand === 'codex') {
            args.push('--resume', options.resumeCodexThreadId);
          }

          if (spawnPermissionMode) {
            args.push('--permission-mode', spawnPermissionMode);
          }

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          return spawnTrackedHappyProcess({
            args,
            cwd: directory,
            env: {
              ...process.env,
              ...extraEnv
            },
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
            variant: options.variant,
            spawnedBy: options.spawnedBy,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const spawnTrackedHappyProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
      variant,
      spawnedBy,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
      /** C2b (B-051): tag the TrackedSession as assistant AT SPAWN TIME, not
       *  only when the webhook backfills metadata — the singleton live-check
       *  must hold in the pre-webhook window. */
      variant?: 'assistant';
      /** B-069: spawn-origin tag (see TrackedSession.spawnedBy). */
      spawnedBy?: string;
    }): Promise<SpawnSessionResult> => {
      const happyProcess = spawnHappyCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!happyProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Happy process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: happyProcess.pid,
        childProcess: happyProcess,
        directoryCreated,
        message,
        variant,
        spawnedBy,
      };

      pidToTrackedSession.set(happyProcess.pid, trackedSession);

      happyProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      happyProcess.on('error', (error) => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(happyProcess.pid!);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
          // B-264: kill the leaked child. Without this the timed-out process
          // keeps running and later webhooks in as an externally-started
          // session, so a caller that retries after the error (or a restart
          // sweep) double-spawns onto the same session row + key. Killing it
          // makes the error terminal — the caller retries onto a clean slate.
          if (happyProcess.pid) {
            try { terminateProcess(happyProcess.pid, () => {}); } catch { /* best effort */ }
          }
          resolve({
            type: 'error',
            errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
          });
        }, 15_000);

        pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
          clearTimeout(timeout);
          logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
          resolve({
            type: 'success',
            sessionId: completedSession.happySessionId!
          });
        });
      });
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    // B-272: the restore record written after a resume/restart spawn succeeded.
    // The webhook has just persisted the NEW wrapper's identity and versions;
    // this write only adds the conversation truth (claudeSessionId etc.) the
    // webhook snapshot lacks. It must not clobber that identity with the
    // pre-spawn copy — a stale hostPid meant the next daemon restart could not
    // re-adopt the wrapper, and restart-session then double-spawned onto it.
    const persistRestoreRecord = (happySessionId: string, fallback: TrackedSession, metadata: Metadata) => {
      const candidates = [...pidToTrackedSession.values()].filter((s) => s.happySessionId === happySessionId && isPidAlive(s.pid));
      const live = candidates.find((s) => s.childProcess) ?? candidates[0];
      const encryption = live?.encryption ?? fallback.encryption;
      if (!encryption) return;
      persistSession(happySessionId, {
        encryptionKey: encodeBase64(encryption.encryptionKey),
        encryptionVariant: encryption.encryptionVariant,
        seq: encryption.seq,
        metadataVersion: encryption.metadataVersion,
        agentStateVersion: encryption.agentStateVersion,
        metadata: mergeRestoreMetadata(metadata, live?.happySessionMetadataFromLocalWebhook),
        savedAt: Date.now(),
      });
    };

    const fetchServerSessionMetadata = async (sessionId: string, encryptionKey: Uint8Array, encryptionVariant: 'legacy' | 'dataKey'): Promise<Metadata | null> => {
      // B-265: by-id first (a session older than the list's 150-row window is
      // otherwise unresolvable); old servers 404 → the list as before.
      try {
        const byId = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
          timeout: 10_000,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
        });
        if (byId.status !== 404) {
          const row = (byId.data as { session?: { metadata: string } }).session;
          if (row?.metadata) return decrypt(encryptionKey, encryptionVariant, decodeBase64(row.metadata)) as Metadata | null;
        }
      } catch (error) {
        logger.debug(`[DAEMON RUN] by-id session metadata fetch failed, falling back to list: ${error instanceof Error ? error.message : error}`);
      }
      try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
          timeout: 10_000,
        });
        const sessions = (response.data as { sessions: { id: string; metadata: string }[] }).sessions;
        const matched = sessions.find(s => s.id === sessionId);
        if (!matched) return null;
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(matched.metadata));
        return decrypted as Metadata | null;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session metadata from server: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    };

    // B-265: one in-flight resume per session (the RPC layer runs handlers
    // concurrently; a double click or two devices must not spawn twice), and a
    // live process wins outright. Precheck failures carry a fixed
    // `resume-precheck:<reason>` prefix the web maps to user-facing text.
    const resumeGates = new Map<string, SpawnGate<SpawnSessionResult>>();
    const resumeSession = async (happySessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      let gate = resumeGates.get(happySessionId);
      if (!gate) {
        gate = createSpawnGate<SpawnSessionResult>();
        resumeGates.set(happySessionId, gate);
      }
      try {
        return await gate.join(() => resumeSessionImpl(happySessionId, options));
      } finally {
        if (!gate.inFlight()) resumeGates.delete(happySessionId);
      }
    };

    const resumeSessionImpl = async (happySessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      try {
        for (const [pid, live] of pidToTrackedSession.entries()) {
          if (live.happySessionId !== happySessionId) continue;
          if (isPidAlive(pid)) {
            logger.debug(`[DAEMON RUN] resume ${happySessionId}: process ${pid} already alive — idempotent success`);
            return { type: 'success', sessionId: happySessionId };
          }
          // An externally started session that died never fires onChildExited;
          // finalize it now so the entry moves to the resumable set.
          onChildExited(pid);
        }
        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          return { type: 'error', errorMessage: `resume-precheck:not-tracked: Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon, more than 14 days ago, or on another machine.` };
        }
        // B-272: a wrapper this daemon never tracked (spawned by a previous
        // daemon, record's hostPid stale) is still the live writer for this
        // session — adopt it instead of spawning a second one next to it.
        const orphans = findSessionWrapperPids(tracked.happySessionMetadataFromLocalWebhook, await findAllHappyProcesses(), { excludePid: process.pid, lockPid: readSessionLock(happySessionId)?.pid })
          .filter((pid) => isPidAlive(pid) && !pidToTrackedSession.has(pid));
        if (orphans.length > 0) {
          for (const pid of orphans) {
            pidToTrackedSession.set(pid, { ...tracked, pid, startedBy: 'adopted untracked wrapper' });
          }
          logger.debug(`[DAEMON RUN] resume ${happySessionId}: adopted untracked live wrapper(s) ${orphans.join(', ')} — idempotent success`);
          return { type: 'success', sessionId: happySessionId };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: `resume-precheck:no-metadata: Session ${happySessionId} has no metadata. Cannot resume.` };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: `resume-precheck:no-encryption: Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.` };
        }

        // Webhook metadata may be stale (missing claudeSessionId/codexThreadId set after startup).
        // Fetch fresh metadata from server if needed.
        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
          || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
          logger.debug(`[DAEMON RUN] Session ${happySessionId} missing agent session ID in webhook metadata, fetching from server`);
          const serverMetadata = await fetchServerSessionMetadata(happySessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
          if (serverMetadata) {
            metadata = serverMetadata;
            tracked.happySessionMetadataFromLocalWebhook = serverMetadata;
          }
        }

        const precheck = resumePrecheck(metadata, {
          cwdExists: (p) => existsSync(p),
          conversationExists: (cwd, claudeSessionId) => existsSync(join(getProjectPath(cwd), `${claudeSessionId}.jsonl`)),
        });
        if (!precheck.ok) {
          return { type: 'error', errorMessage: `resume-precheck:${precheck.reason}: ${precheck.detail}` };
        }

        const launch = buildResumeLaunch(
          { id: happySessionId, active: true, metadata },
          { startedBy: 'daemon', claudeStartingMode: 'remote' },
        );

        const model = sanitizeResumeModel(options?.model);
        if (model) launch.args.push('--model', model);
        else if (options?.model !== undefined) logger.debug(`[DAEMON RUN] resume: ignoring invalid model ${JSON.stringify(options.model)}`);
        const permissionMode = sanitizeSpawnPermissionMode(options?.permissionMode);
        if (permissionMode) launch.args.push('--permission-mode', permissionMode);
        else if (options?.permissionMode !== undefined) logger.debug(`[DAEMON RUN] resume: ignoring invalid permission mode ${JSON.stringify(options.permissionMode)}`);

        const result = await spawnTrackedHappyProcess({
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...process.env,
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(tracked.encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
          },
        });
        if (result.type === 'success') {
          // Refresh the on-disk restore record: `savedAt` (14-day retention now
          // measured from the last time we saw the session alive) and the
          // server-side metadata (claudeSessionId etc.) on top of the NEW
          // wrapper's identity + versions (B-272).
          persistRestoreRecord(happySessionId, tracked, metadata);
        }
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : (error && typeof error === 'object' ? JSON.stringify(error) : String(error));
        logger.debug(`[DAEMON RUN] Failed to resume session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return {
          type: 'error',
          errorMessage: `Failed to resume session: ${errorMessage}`,
        };
      }
    };

    // ── B-264 session restart ────────────────────────────────────────────────
    // Restart differs from resume: resume treats a LIVE wrapper as healthy and
    // returns idempotent success (resumeSessionImpl's live-check) — but a
    // B-266 corpse is a live-but-broken wrapper whose SDK query keeps failing.
    // Restart therefore STOPS the live wrapper first, waits for its exit, then
    // relaunches on the current CLI code. It reuses the same per-session gate as
    // resume (so restart/resume/concurrent-restart never double-spawn) and is
    // bounded by a per-daemon-lifetime circuit breaker.
    const restartCounts = new Map<string, number>();

    // Promise-returning stop: kill the live wrapper for a session and resolve
    // when it has actually exited (terminateProcess settles after SIGTERM→2s→
    // SIGKILL), or immediately when there is no live process. A safety timeout
    // guards a wedged SIGKILL so a restart can never hang forever.
    const stopSessionAndWait = async (happySessionId: string, timeoutMs = 8_000): Promise<void> => {
      const targets = new Set<number>();
      for (const [pid, s] of pidToTrackedSession.entries()) {
        if (s.happySessionId === happySessionId && isPidAlive(pid)) targets.add(pid);
      }
      // B-272: also wrappers this daemon never tracked (spawned by a previous
      // daemon and not re-adopted because the record's hostPid was stale).
      // Leaving one alive here IS the double-spawn: the relaunch would be its
      // second writer.
      const known = findTrackedSessionById(happySessionId)?.happySessionMetadataFromLocalWebhook;
      for (const pid of findSessionWrapperPids(known, await findAllHappyProcesses(), { excludePid: process.pid, lockPid: readSessionLock(happySessionId)?.pid })) {
        if (isPidAlive(pid)) targets.add(pid);
      }
      if (targets.size === 0) return;
      logger.debug(`[DAEMON RUN] restart ${happySessionId}: stopping live wrapper(s) ${[...targets].join(', ')}`);
      await Promise.all([...targets].map((pid) => new Promise<void>((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const requested = terminateProcess(pid, () => {
          const tracked = pidToTrackedSession.get(pid);
          if (tracked) {
            if (tracked.happySessionId && tracked.encryption) {
              sessionIdToFinishedSession.set(tracked.happySessionId, tracked);
            }
            pidToTrackedSession.delete(pid);
          }
          done();
        });
        if (!requested) done();
        setTimeout(done, timeoutMs).unref?.();
      })));
    };

    const restartSession = async (happySessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      let gate = resumeGates.get(happySessionId);
      if (!gate) {
        gate = createSpawnGate<SpawnSessionResult>();
        resumeGates.set(happySessionId, gate);
      }
      try {
        // `replace` (not `join`): a restart must actually run and must serialize
        // AFTER any in-flight resume for the same session rather than dedupe
        // into it — otherwise a "Restart" click could no-op onto a resume.
        return await gate.replace(() => restartSessionImpl(happySessionId, options));
      } finally {
        if (!gate.inFlight()) resumeGates.delete(happySessionId);
      }
    };

    const restartSessionImpl = async (happySessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      try {
        const prior = restartCounts.get(happySessionId) ?? 0;
        const decision = decideRestart(prior, DEFAULT_MAX_RESTARTS);
        if (!decision.allowed) {
          return { type: 'error', errorMessage: `restart:${decision.reason}` };
        }

        // Stop the live (broken) wrapper and wait for it to exit; finalization
        // moves the tracked entry into the resumable set with its encryption.
        await stopSessionAndWait(happySessionId);

        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          return { type: 'error', errorMessage: `restart-precheck:not-tracked: Session ${happySessionId} is not tracked by this daemon.` };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: `restart-precheck:no-metadata: Session ${happySessionId} has no metadata. Cannot restart.` };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: `restart-precheck:no-encryption: Session ${happySessionId} has no stored encryption data. Restart the daemon and start a new session.` };
        }

        // Server metadata may carry the agent session id the webhook snapshot
        // lacks (the id only ever reaches the server). Fetch if the local copy
        // is missing it — same as resume.
        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
          || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
          const serverMetadata = await fetchServerSessionMetadata(happySessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
          if (serverMetadata) {
            metadata = serverMetadata;
            tracked.happySessionMetadataFromLocalWebhook = serverMetadata;
          }
        }

        // Build the relaunch. Guarded: --resume only when the agent conversation
        // is genuinely resumable (id present + transcript on disk). A B-266
        // corpse (claude session that died at 0s, never got a claudeSessionId)
        // falls through to a FRESH reconnect that reuses the same session row
        // via HAPPY_RECONNECT — no --resume, which would crash on a missing
        // transcript. Mirrors the assistant re-attach path.
        const precheck = resumePrecheck(metadata, {
          cwdExists: (p) => existsSync(p),
          conversationExists: (cwd, claudeSessionId) => existsSync(join(getProjectPath(cwd), `${claudeSessionId}.jsonl`)),
        });
        let args: string[];
        let cwd: string;
        if (precheck.ok) {
          const launch = buildResumeLaunch(
            { id: happySessionId, active: true, metadata },
            { startedBy: 'daemon', claudeStartingMode: 'remote' },
          );
          args = launch.args;
          cwd = launch.cwd;
        } else if ((metadata.flavor ?? 'claude') === 'claude' && typeof metadata.path === 'string' && metadata.path.length > 0) {
          cwd = metadata.path;
          if (!existsSync(cwd)) {
            return { type: 'error', errorMessage: `restart-precheck:cwd-missing: ${cwd}` };
          }
          // Fresh reconnect for a corpse: no --resume.
          args = ['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
        } else {
          // Codex without a thread id, or any other non-relaunchable shape.
          return { type: 'error', errorMessage: `restart-precheck:${precheck.ok ? 'unknown' : precheck.reason}: ${precheck.ok ? '' : precheck.detail}` };
        }

        const model = sanitizeResumeModel(options?.model);
        if (model) args.push('--model', model);
        const permissionMode = sanitizeSpawnPermissionMode(options?.permissionMode);
        if (permissionMode) args.push('--permission-mode', permissionMode);

        // Count the attempt now that we are actually spawning (a pre-flight
        // rejection above never burns a slot).
        restartCounts.set(happySessionId, recordRestartAttempt(prior));

        const result = await spawnTrackedHappyProcess({
          args,
          cwd,
          env: {
            ...process.env,
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(tracked.encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
          },
        });
        if (result.type === 'success') {
          persistRestoreRecord(happySessionId, tracked, metadata);
        }
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`[DAEMON RUN] Failed to restart session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return { type: 'error', errorMessage: `Failed to restart session: ${errorMessage}` };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          const requested = terminateProcess(pid, (stopped) => {
            if (!stopped) {
              logger.debug(`[DAEMON RUN] Session ${sessionId} survived SIGTERM and SIGKILL attempts`);
              return;
            }
            const tracked = pidToTrackedSession.get(pid);
            if (!tracked) return; // child exit handler already finalized it
            if (tracked.happySessionId && tracked.encryption) {
              sessionIdToFinishedSession.set(tracked.happySessionId, tracked);
            }
            pidToTrackedSession.delete(pid);
            logger.debug(`[DAEMON RUN] Verified session ${sessionId} stopped and removed it from tracking`);
          });
          if (requested) {
            logger.debug(`[DAEMON RUN] Requested verified termination for session ${sessionId} (PID ${pid})`);
          } else {
            logger.debug(`[DAEMON RUN] Failed to signal session ${sessionId} (PID ${pid})`);
          }
          return requested;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.happySessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.happySessionId, session);
        logger.debug(`[DAEMON RUN] Process PID ${pid} exited, preserved session ${session.happySessionId} for resume`);
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
    };

    // ── B-069: 主动汇报 sink ────────────────────────────────────────────────
    // A session the assistant dispatched reports its stable state transitions
    // here (via /session-event, emitted from the session process's turn-end /
    // permission chain — the chat-session counterpart of the B-012 terminal
    // tracker). When it completed or needs input and a live assistant session
    // exists on this machine, forward a [系统通报] user message into the
    // assistant so it verifies with session_read and reports aloud. All gates
    // (origin tag / self-report / live target / 5min per-session cooldown) are
    // pure in assistantReport.ts; failures only ever debug-log.
    const assistantReportLastSentAt = new Map<string, number>();
    const isPidAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const onSessionStateEvent = (sessionId: string, event: AssistantReportEvent, spawnedByFromSession?: string): void => {
      void (async () => {
        try {
          let tracked: TrackedSession | undefined;
          for (const s of pidToTrackedSession.values()) {
            if (s.happySessionId === sessionId) {
              tracked = s;
              break;
            }
          }
          const liveAssistant = findLiveAssistant(pidToTrackedSession.values(), isPidAlive);
          const decision = decideAssistantReport({
            // The tracked tag is authoritative; the session's own echo covers
            // a daemon restart that lost the in-memory tracking.
            spawnedBy: tracked?.spawnedBy ?? spawnedByFromSession,
            isAssistantSession: tracked ? isAssistantTracked(tracked) : false,
            sessionId,
            assistantSessionId: liveAssistant?.happySessionId,
            lastReportAt: assistantReportLastSentAt.get(sessionId),
            now: Date.now(),
          });
          if (!decision.send) {
            logger.debug(`[DAEMON RUN] Assistant report skipped for ${sessionId} (${event}): ${decision.reason}`);
            return;
          }
          const persisted = readPersistedSessions();
          const assistantEntry = persisted[decision.assistantSessionId];
          if (!assistantEntry) {
            logger.debug(`[DAEMON RUN] Assistant report skipped for ${sessionId} (${event}): no session key for assistant ${decision.assistantSessionId}`);
            return;
          }
          const title = resolveReportSessionTitle(
            tracked?.happySessionMetadataFromLocalWebhook ?? persisted[sessionId]?.metadata,
            sessionId,
          );
          // Burn the cooldown slot before the network call so a slow send
          // can't let a burst through.
          assistantReportLastSentAt.set(sessionId, Date.now());
          await sendUserMessage(
            decision.assistantSessionId,
            assistantEntry,
            formatAssistantReportMessage(title, sessionId, event),
            'assistant-report',
          );
          logger.debug(`[DAEMON RUN] Assistant report sent: session ${sessionId} ${event} → assistant ${decision.assistantSessionId}`);
        } catch (error) {
          logger.debug(`[DAEMON RUN] Assistant report failed for ${sessionId} (${event}):`, error);
        }
      })();
    };

    // Start control server. The clipboard push needs the machine socket, which
    // is created further down — late-bind through a ref so /clipboard picked up
    // the client once it exists (requests before that get delivered: false).
    let apiMachineRef: ApiMachineClient | null = null;
    // B-105: mirror manager is constructed after the API client below —
    // late-bind so /terminal-hook requests during startup are dropped safely.
    let mirrorManagerRef: MirrorManager | null = null;
    const controlToken = createDaemonControlToken();
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      controlToken,
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      onSessionStateEvent,
      pushClipboard: (text: string) => {
        if (!apiMachineRef) {
          return { delivered: false, truncated: false, totalBytes: 0, error: 'daemon is still starting up' };
        }
        return apiMachineRef.pushClipboard(text);
      },
      onTerminalHook: (body: unknown) => {
        mirrorManagerRef?.handleHookPayload(body);
      }
    });

    // Write initial daemon state (no lock needed for state file)
    const daemonClaudeCredentials = resolveClaudeCredentialReadiness();
    let fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      controlToken,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      serverUrl: configuration.serverUrl,
      webappUrl: configuration.webappUrl,
      daemonLogPath: logger.logFilePath,
      claudeCredentialSource: daemonClaudeCredentials.source,
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Capture the bundled CLI's mtime at startup so the heartbeat can detect
    // when npm replaces `dist/index.mjs` on disk (= the user ran `npm i -g happy`).
    // We previously compared disk `package.json.version` to our bundled version,
    // but that produced infinite restart loops (#1107) when the manifest version
    // diverged from the bundled version (e.g. `happy-coder@0.13.1` deprecation
    // stub bumped package.json without rebuilding dist). File mtime is a more
    // reliable signal: it only changes when the bundle is actually replaced.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug(`[DAEMON RUN] Bundle at ${bundlePath} not found; self-restart on upgrade disabled`);
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    apiMachineRef = apiMachine;

    // ── B-105: terminal mirror ──────────────────────────────────────────────
    // Hand-typed claude sessions inside vh web terminals get mirrored into
    // read-only shadow sessions hosted by THIS process. Hooks arrive on the
    // control server's /terminal-hook; terminal lifecycle (close, claude exit
    // observed on the pane) flows in from the web-terminal tracker.
    const mirrorManager = createMirrorManager({
      api,
      machineId,
      onBindingsChanged: () => apiMachine.requestTerminalListRefresh(),
    });
    mirrorManagerRef = mirrorManager;
    apiMachine.setMirrorIntegration({
      resolveMirrorSessionId: (terminalId) => mirrorManager.resolveMirrorSessionId(terminalId),
      onTerminalClosed: (terminalId) => mirrorManager.onTerminalClosed(terminalId),
      onTerminalList: (terminals) => mirrorManager.observeTerminalList(terminals),
      onTerminalListTick: (terminals) => mirrorManager.reconcile(terminals),
      isMirrorInputAllowed: (terminalId) => mirrorManager.isMirrorInputAllowed(terminalId),
    });
    // Re-adopt mirrors for terminals that survived the daemon restart (tail
    // replay is idempotent via mirror localIds).
    mirrorManager.restore().catch((error) => {
      logger.debug('[DAEMON RUN] Mirror restore failed:', error);
    });

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      restartSession,
      stopSession,
      listTrackedSessionIds: () => [...pidToTrackedSession.values()]
        .map((session) => session.happySessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string'),
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    // The daemon is the long-lived, relay-aware update checker. It never runs
    // npm: it only publishes the relay's version policy for Web/CLI UX. A
    // successful local npm install is already handed over by the bundle-mtime
    // mechanism below.
    let cliUpdateCheckRunning = false;
    const refreshCliUpdate = async () => {
      if (cliUpdateCheckRunning) return;
      cliUpdateCheckRunning = true;
      try {
        const cliUpdate = await fetchCliUpdateState(configuration.serverUrl, packageJson.version);
        if (!cliUpdate) return;
        fileState = { ...fileState, cliUpdate };
        writeDaemonState(fileState);
        apiMachine.setCliUpdateState(cliUpdate);
        logger.debug(`[DAEMON RUN] CLI update policy checked: ${cliUpdate.status} (recommended=${cliUpdate.recommendedVersion ?? 'none'}, minimum=${cliUpdate.minimumVersion ?? 'none'})`);
      } catch (error) {
        logger.debug('[DAEMON RUN] CLI update policy check failed:', error);
      } finally {
        cliUpdateCheckRunning = false;
      }
    };
    void refreshCliUpdate();
    const cliUpdateIntervalMs = resolveCliUpdateCheckInterval(process.env.HAPPY_CLI_UPDATE_CHECK_INTERVAL);
    if (process.env.HAPPY_CLI_UPDATE_CHECK_INTERVAL && cliUpdateIntervalMs === DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS
      && process.env.HAPPY_CLI_UPDATE_CHECK_INTERVAL.trim() !== String(DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS)) {
      logger.warn(`[DAEMON RUN] Ignoring invalid HAPPY_CLI_UPDATE_CHECK_INTERVAL; using ${DEFAULT_CLI_UPDATE_CHECK_INTERVAL_MS}ms`);
    }
    const cliUpdateInterval = setInterval(() => void refreshCliUpdate(), cliUpdateIntervalMs);

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Recovered processes have no ChildProcess 'exit' listener after a
          // daemon restart. Route stale pruning through the same finalizer so
          // their persisted encryption/resume state remains discoverable.
          logger.debug(`[DAEMON RUN] Finalizing stale session with PID ${pid} (process no longer exists)`);
          onChildExited(pid);
        }
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced) {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);
        clearInterval(cliUpdateInterval);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `very-happy daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningCurrentlyInstalledHappyVersion() === true, and exits —
        // leaving nothing running once we also exit.
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        // Preserve the process control token (and any future state fields)
        // instead of silently dropping them on the first heartbeat.
        fileState = withDaemonHeartbeat(fileState, new Date().toLocaleString());
        writeDaemonState(fileState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${fileState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }
      clearInterval(cliUpdateInterval);

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      // Flush mirror outboxes and close their sockets — WITHOUT archiving
      // (a restart re-adopts live mirrors via restore()).
      try {
        await mirrorManager.shutdown();
      } catch (error) {
        logger.debug('[DAEMON RUN] Mirror shutdown failed:', error);
      }

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
