/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface SessionEncryptionData {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  encryption?: SessionEncryptionData;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /**
   * B-051: set at SPAWN TIME for the assistant (meta-agent) session, so the
   * singleton live-check works even in the window before the session's
   * webhook fills happySessionMetadataFromLocalWebhook.
   */
  variant?: 'assistant';
  /**
   * B-069: who requested this spawn ('assistant' = dispatched via the
   * assistant's session_spawn tool). Old clients never send it → undefined.
   * Drives the daemon → assistant 主动汇报 sink (assistantReport.ts).
   */
  spawnedBy?: string;
}

/**
 * B-497: one live session as the daemon's `/peers` reports it — managed
 * children plus active terminal-mirror shadows, each with the real paths it
 * edited inside the conflict window.
 */
export interface PeerSessionInfo {
  sessionId: string;
  kind: 'managed' | 'mirror';
  pid?: number;
  cwd?: string;
  flavor?: string;
  title?: string;
  variant?: string;
  edits: Array<{ path: string; tool: string; at: number }>;
}