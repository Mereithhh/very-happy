export interface ArchiveResult {
  success: boolean;
  message?: string;
}

/**
 * `killSession` is a best-effort prelude to the authoritative relay archive,
 * not a long-running session operation. Keep this below the 5s local inactive
 * hold so an unavailable CLI cannot leave the row hidden only in memory while
 * the server still reports it active.
 */
export const ARCHIVE_KILL_DEADLINE_MS = 3_000;

async function attemptKillWithinDeadline(
  kill: () => Promise<ArchiveResult>,
  deadlineMs: number,
): Promise<ArchiveResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      kill(),
      new Promise<ArchiveResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          success: false,
          message: 'Timed out waiting for session to stop',
        }), deadlineMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Stop a live client when possible, with a short deadline, then always make the
 * relay's inactive flag authoritative. The deadline matters as much as the
 * ordering: the generic session RPC timeout is five minutes, while an offline
 * CLI must not postpone the authoritative archive for five minutes.
 * `killSession` also acknowledges before the CLI finishes its async cleanup,
 * so treating that acknowledgement as the archive result leaves a race where
 * a final activity update keeps the row alive forever.
 */
export async function commitSessionArchive(
  kill: () => Promise<ArchiveResult>,
  archive: () => Promise<ArchiveResult>,
  killDeadlineMs = ARCHIVE_KILL_DEADLINE_MS,
): Promise<void> {
  let killFailure: string | undefined;
  try {
    const result = await attemptKillWithinDeadline(kill, killDeadlineMs);
    if (!result.success) killFailure = result.message;
  } catch (error) {
    killFailure = error instanceof Error ? error.message : 'Failed to stop session';
  }

  const result = await archive();
  if (!result.success) {
    throw new Error(result.message || killFailure || 'Failed to archive session');
  }
}
