/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, readFileSync, unlinkSync, renameSync } from 'node:fs'
import { constants } from 'node:fs'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { CliUpdateState, Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { credentialRelayProblem } from '@/ui/authRelay';
import {
  ensurePrivateDirectory,
  hardenPrivateFile,
  hardenPrivateFileSync,
  PRIVATE_FILE_MODE,
  writePrivateFile,
  writePrivateFileSync,
} from '@/utils/secureFiles';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaceRoot: z.string().optional(),
  sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
  customWritePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default(['~/.ssh', '~/.aws', '~/.gnupg']),
  extraWritePaths: z.array(z.string()).default(['/tmp']),
  denyWritePaths: z.array(z.string()).default(['.env']),
  networkMode: z.enum(['blocked', 'allowed', 'custom']).default('allowed'),
  allowedDomains: z.array(z.string()).default([]),
  deniedDomains: z.array(z.string()).default([]),
  allowLocalBinding: z.boolean().default(true),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
export const SUPPORTED_SCHEMA_VERSION = 2;

interface Settings {
  schemaVersion: number
  onboardingCompleted: boolean
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningHappy?: boolean
  chromeMode?: boolean
  sandboxConfig?: SandboxConfig
  serverUrl?: string
  webappUrl?: string
  /**
   * Task Board V2 opt-in: let sessions on this machine run the boardAnalyzer
   * LLM bypass (one-shot `claude -p --model haiku` per session, throttled).
   * Machine-local ON PURPOSE: the synced web settings blob is client-side
   * encrypted and the CLI cannot read it — the web settings page tells users
   * to flip this here. Absent/false = disabled (never burn tokens silently).
   */
  boardLlm?: boolean
  /**
   * B-276: which credential store the Claude Code processes spawned by this
   * daemon may use. `file` prepends the keychain-off `security` shim to their
   * PATH so they behave like an ssh/tmux shell (only ~/.claude/.credentials.json);
   * absent/`auto` = Claude Code's own keychain-first behaviour.
   */
  claudeCredentialStore?: 'auto' | 'file'
  /**
   * B-007: external todo provider — a user-supplied command that speaks the
   * contract in docs/channels.md (`<command> list|complete <id>|create <title>`).
   *
   * Machine-local AND deliberately NOT settable from the web: this command runs
   * as arbitrary code on this machine, so letting a (potentially hijacked) web
   * session set it would be an RCE. Absent = the web Todo panel stays disabled.
   */
  todoProvider?: {
    command: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }
  /**
   * B-150 terminal auto-restore: after a daemon/machine restart, bring the last
   * working set back by itself (same cwd, `claude --resume` into the same
   * conversation) so logging in and opening the web shows the terminals already
   * running — no clicking.
   *
   * Machine-local for two reasons: the CLI cannot read the client-encrypted
   * synced settings blob (same constraint as `boardLlm`), AND a memory budget
   * is a property of THIS machine — 6 restored claude TUIs is ~2.5GB, which is
   * fine on a 24GB laptop and not on a small VM. Syncing it would be wrong.
   *
   * Absent → enabled with the conservative defaults in terminal/autoRestore.ts
   * (max 6, 24h recency window). `terminalAutoRestoreMax: 0` also means off.
   */
  terminalAutoRestore?: boolean
  terminalAutoRestoreMax?: number
  terminalAutoRestoreWindowHours?: number
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  sandboxConfig: undefined,
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  let migrated = { ...raw };

  // Future migrations go here:
  // if (fromVersion < 3) { ... }

  return migrated;
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  /**
   * Per-process credential for the loopback HTTP control plane. Optional only
   * so a new CLI can still stop/query an old daemon state written before auth.
   */
  controlToken?: string;
  startTime: string;
  startedWithCliVersion: string;
  serverUrl?: string;
  webappUrl?: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
  /** Non-secret category captured from the daemon's own startup environment. */
  claudeCredentialSource?: string;
  /** Last successful relay update-policy check; safe to show in doctor output. */
  cliUpdate?: CliUpdateState;
}

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    // Read raw settings
    const content = await readFile(configuration.settingsFile, 'utf8')
    const raw = JSON.parse(content)

    // Check schema version (default to 1 if missing)
    const schemaVersion = raw.schemaVersion ?? 1;

    // Warn if schema version is newer than supported
    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      logger.warn(
        `⚠️ Settings schema v${schemaVersion} > supported v${SUPPORTED_SCHEMA_VERSION}. ` +
        'Update happy-cli for full functionality.'
      );
    }

    // Migrate if needed
    const migrated = migrateSettings(raw, schemaVersion);

    if (migrated.sandboxConfig !== undefined) {
      try {
        migrated.sandboxConfig = SandboxConfigSchema.parse(migrated.sandboxConfig);
      } catch (error: any) {
        logger.warn(`⚠️ Invalid sandbox config - skipping. Error: ${error.message}`);
        migrated.sandboxConfig = undefined;
      }
    }

    // Merge with defaults to ensure all required fields exist
    return { ...defaultSettings, ...migrated };
  } catch (error: any) {
    logger.warn(`Failed to read settings: ${error.message}`);
    // Return defaults on any error
    return { ...defaultSettings }
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await ensurePrivateDirectory(configuration.happyHomeDir)

  // Ensure schema version is set before writing
  const settingsWithVersion = {
    ...settings,
    schemaVersion: settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION
  };

  await writePrivateFile(configuration.settingsFile, JSON.stringify(settingsWithVersion, null, 2))
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    await ensurePrivateDirectory(configuration.happyHomeDir);

    // Write atomically using rename
    await writePrivateFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX
    await hardenPrivateFile(configuration.settingsFile);

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  authServerUrl: z.string().optional(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64()
  }).nullish()
})

export type Credentials = {
  token: string,
  /** Relay that issued this token. Absent only on credentials written by older CLIs. */
  authServerUrl?: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    if (credentials.secret) {
      return {
        token: credentials.token,
        authServerUrl: credentials.authServerUrl,
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        authServerUrl: credentials.authServerUrl,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  }
  return null
}

/** Read credentials only when they are known to belong to the configured relay. */
export async function readCredentialsForConfiguredRelay(): Promise<Credentials | null> {
  const credentials = await readCredentials();
  if (!credentials) return null;
  const relayProblem = credentialRelayProblem(credentials.authServerUrl, configuration.serverUrl);
  if (relayProblem) {
    throw new Error(
      `${relayProblem} Use a separate HAPPY_HOME_DIR for this relay, ` +
      'or run `very-happy auth login --force` before making relay requests.'
    );
  }
  return credentials;
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  await ensurePrivateDirectory(configuration.happyHomeDir)
  await writePrivateFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token,
    authServerUrl: configuration.serverUrl
  }, null, 2));
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  await ensurePrivateDirectory(configuration.happyHomeDir)
  await writePrivateFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token,
    authServerUrl: configuration.serverUrl
  }, null, 2));
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return null;
    }
    const content = await readFile(configuration.daemonStateFile, 'utf-8');
    return JSON.parse(content) as DaemonLocallyPersistedState;
  } catch (error) {
    // State corrupted somehow :(
    console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
    return null;
  }
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writePrivateFileSync(configuration.daemonStateFile, JSON.stringify(state, null, 2));
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  // Also clean up lock file if it exists (for stale cleanup)
  if (existsSync(configuration.daemonLockFile)) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            try {
              process.kill(Number(lockPid), 0); // Check if process exists
            } catch {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    if (existsSync(configuration.daemonLockFile)) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}

// ─── Session persistence (survives daemon restarts) ───

export type PersistedSession = {
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
  metadata: Metadata;
  savedAt: number;
};

type SessionsFile = {
  sessions: Record<string, PersistedSession>;
};

const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function readPersistedSessions(): Record<string, PersistedSession> {
  try {
    if (!existsSync(configuration.sessionsFile)) return {};
    const data = JSON.parse(readFileSync(configuration.sessionsFile, 'utf-8')) as SessionsFile;
    if (!data?.sessions || typeof data.sessions !== 'object') return {};

    const now = Date.now();
    const sessions: Record<string, PersistedSession> = {};
    for (const [id, session] of Object.entries(data.sessions)) {
      if (now - session.savedAt < SESSION_MAX_AGE_MS) {
        sessions[id] = session;
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

export function persistSession(sessionId: string, session: PersistedSession): void {
  try {
    const existing = readPersistedSessions();
    existing[sessionId] = session;
    const tmpFile = configuration.sessionsFile + '.tmp';
    writePrivateFileSync(tmpFile, JSON.stringify({ sessions: existing }, null, 2));
    renameSync(tmpFile, configuration.sessionsFile);
    hardenPrivateFileSync(configuration.sessionsFile);
  } catch (error) {
    logger.debug(`[PERSISTENCE] Failed to persist session ${sessionId}:`, error);
  }
}

/**
 * Remove specific sessions from sessions.json. Used by the assistant
 * forceNew spawn path (B-051): the old assistant entry must be forgotten so
 * the daemon never re-attaches to it. Best-effort, same discipline as
 * persistSession.
 */
export function deletePersistedSessions(sessionIds: string[]): void {
  try {
    const existing = readPersistedSessions();
    let changed = false;
    for (const id of sessionIds) {
      if (id in existing) {
        delete existing[id];
        changed = true;
      }
    }
    if (!changed) return;
    const tmpFile = configuration.sessionsFile + '.tmp';
    writePrivateFileSync(tmpFile, JSON.stringify({ sessions: existing }, null, 2));
    renameSync(tmpFile, configuration.sessionsFile);
    hardenPrivateFileSync(configuration.sessionsFile);
  } catch (error) {
    logger.debug(`[PERSISTENCE] Failed to delete persisted sessions:`, error);
  }
}
