import type { SpawnSessionResult } from './ops';

interface LifecycleTransitionResult {
  success: boolean;
  supported?: boolean;
  message?: string;
}

/** Make resume an explicit, compensating lifecycle transition. The archive
 * rollback is awaited so a failed spawn cannot be followed by a tab close that
 * strands the session in an unarchived-but-offline state. */
export async function commitSessionResume(
  unarchive: () => Promise<LifecycleTransitionResult>,
  resume: () => Promise<SpawnSessionResult>,
  rearchive: () => Promise<LifecycleTransitionResult>,
): Promise<SpawnSessionResult> {
  const transition = await unarchive();
  if (!transition.success) {
    return { type: 'error', errorMessage: transition.message || 'Failed to prepare session resume' };
  }

  let result: SpawnSessionResult;
  try {
    result = await resume();
  } catch (error) {
    result = {
      type: 'error',
      errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
    };
  }

  if (result.type === 'success' || transition.supported === false) return result;

  const rollback = await rearchive();
  if (!rollback.success) {
    const original = result.type === 'error' ? result.errorMessage : 'Session was not started';
    return {
      type: 'error',
      errorMessage: `${original}; failed to restore archive state: ${rollback.message || 'unknown error'}`,
    };
  }
  return result;
}
