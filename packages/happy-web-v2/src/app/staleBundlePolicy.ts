export const STALE_BUNDLE_RELOAD_GUARD_MS = 10 * 60_000;

export type StaleBundleReloadGuard = {
  entry: string;
  attemptedAt: number;
};

export type StaleBundleReloadDecision =
  | { action: 'reload' }
  | { action: 'wait'; retryAfterMs: number };

export function parseStaleBundleReloadGuard(value: string | null): StaleBundleReloadGuard | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StaleBundleReloadGuard>;
    if (typeof parsed.entry !== 'string' || !parsed.entry) return null;
    if (typeof parsed.attemptedAt !== 'number' || !Number.isFinite(parsed.attemptedAt)) return null;
    return { entry: parsed.entry, attemptedAt: parsed.attemptedAt };
  } catch {
    return null;
  }
}

export function serializeStaleBundleReloadGuard(guard: StaleBundleReloadGuard): string {
  return JSON.stringify(guard);
}

export function decideStaleBundleReload(
  storedGuard: string | null,
  serverEntry: string,
  now: number,
): StaleBundleReloadDecision {
  const guard = parseStaleBundleReloadGuard(storedGuard);
  if (!guard || guard.entry !== serverEntry) return { action: 'reload' };
  const retryAfterMs = STALE_BUNDLE_RELOAD_GUARD_MS - (now - guard.attemptedAt);
  return retryAfterMs > 0 ? { action: 'wait', retryAfterMs } : { action: 'reload' };
}
