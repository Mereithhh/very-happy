import type { SpawnSessionResult } from './ops';

/** A daemon handler that throws reaches the web as `{ error }` (no `type`),
 * see RpcHandlerManager — fold it into the SpawnSessionResult shape so callers
 * can read `errorMessage` uniformly. Anything else unrecognised is an error too. */
export function normalizeResumeResult(raw: unknown): SpawnSessionResult {
  const r = raw as { type?: string; error?: unknown; errorMessage?: unknown; sessionId?: unknown; directory?: unknown } | null;
  if (r && typeof r === 'object') {
    if (r.type === 'success' && typeof r.sessionId === 'string') return { type: 'success', sessionId: r.sessionId };
    if (r.type === 'requestToApproveDirectoryCreation' && typeof r.directory === 'string') return { type: 'requestToApproveDirectoryCreation', directory: r.directory };
    if (r.type === 'error') return { type: 'error', errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : 'Failed to resume session' };
    if (typeof r.error === 'string') return { type: 'error', errorMessage: r.error };
  }
  return { type: 'error', errorMessage: 'Unexpected resume response' };
}

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
    result = normalizeResumeResult(await resume());
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
