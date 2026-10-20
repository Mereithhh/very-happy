/** One recovery per target shell and tab; concurrent lazy imports share it. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

/**
 * B-639: what the route/bootstrap error page should say. Only a chunk failure
 * is a network/deploy problem; an unknown path is a 404 (the server's SPA
 * fallback serves index.html for every path, so the router is the one that
 * says so); anything else is a bug and "check your connection" would mislead.
 */
export type RouteFailureKind = 'chunk' | 'not-found' | 'error';
export function routeFailureKind(error: unknown): RouteFailureKind {
  if (isChunkLoadError(error)) return 'chunk';
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return status === 404 ? 'not-found' : 'error';
}

export type RecoveryResult = 'reloading' | 'unavailable' | 'blocked';
export function createChunkRecovery(deps: {
  entry(): Promise<string | null>;
  storage(): Pick<Storage, 'getItem' | 'setItem'>;
  apply(entry: string): Promise<void>;
}) {
  let pending: Promise<RecoveryResult> | undefined;
  let running = false;
  return (manual = false): Promise<RecoveryResult> => {
    if (pending && (running || !manual)) return pending;
    const run = async (): Promise<RecoveryResult> => {
      const entry = await deps.entry();
      if (!entry) return 'unavailable';
      // Persist before applying. If storage is unavailable, automatic reload is
      // unsafe: a new document would forget the guard and loop indefinitely.
      try {
        const key = 'vh-chunk-recovery-entry';
        if (!manual && deps.storage().getItem(key) === entry) return 'blocked';
        deps.storage().setItem(key, entry);
      } catch { if (!manual) return 'blocked'; }
      await deps.apply(entry);
      return 'reloading';
    };
    running = true;
    pending = run().catch((): RecoveryResult => 'unavailable').finally(() => { running = false; });
    return pending;
  };
}

/** Preserve the rejection for the route/bootstrap boundary, flush before it unmounts. */
export function installChunkRecovery(
  target: EventTarget,
  flush: () => void,
  recover: () => Promise<RecoveryResult>,
): () => void {
  const onFailure = () => { flush(); void recover(); };
  target.addEventListener('vite:preloadError', onFailure);
  return () => target.removeEventListener('vite:preloadError', onFailure);
}
