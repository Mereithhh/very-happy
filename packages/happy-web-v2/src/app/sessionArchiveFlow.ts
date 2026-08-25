export interface ArchiveResult {
  success: boolean;
  message?: string;
}

/**
 * Commit the authoritative server transition. Process termination is driven
 * downstream by the server after the database write; the browser must never
 * make persistence depend on reaching a local process first.
 */
export async function commitSessionArchive(
  archive: () => Promise<ArchiveResult>,
): Promise<void> {
  const result = await archive();
  if (!result.success) {
    throw new Error(result.message || 'Failed to archive session');
  }
}
