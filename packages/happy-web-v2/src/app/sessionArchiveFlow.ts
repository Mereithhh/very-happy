export interface ArchiveResult {
  success: boolean;
  message?: string;
}

/**
 * Stop a live client when possible, then always make the relay's inactive flag
 * authoritative. `killSession` acknowledges before the CLI finishes its async
 * cleanup, so treating that acknowledgement as the archive result leaves a
 * race where a final activity update keeps the row alive forever.
 */
export async function commitSessionArchive(
  kill: () => Promise<ArchiveResult>,
  archive: () => Promise<ArchiveResult>,
): Promise<void> {
  let killFailure: string | undefined;
  try {
    const result = await kill();
    if (!result.success) killFailure = result.message;
  } catch (error) {
    killFailure = error instanceof Error ? error.message : 'Failed to stop session';
  }

  const result = await archive();
  if (!result.success) {
    throw new Error(result.message || killFailure || 'Failed to archive session');
  }
}
