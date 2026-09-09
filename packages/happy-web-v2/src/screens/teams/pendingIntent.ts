/** Persist request IDs before sending: leaving a form must never authorize another effect. */
export function pendingIntentKey(server: string, accountId: string, scope: string): string {
  if (!accountId) throw new Error('Account identity is not ready');
  return `vh-team-intent:${JSON.stringify([server.replace(/\/+$/, ''), accountId, scope])}`;
}
export function readPendingIntent<T>(key: string, parse: (value: unknown) => T, storage: Pick<Storage, 'getItem'> = localStorage): T | null {
  const raw = storage.getItem(key);
  return raw === null ? null : parse(JSON.parse(raw));
}
export function retainPendingIntent<T extends {requestId: string}>(key: string, proposed: T, parse: (value: unknown) => T, storage: Pick<Storage, 'getItem'|'setItem'> = localStorage): T {
  const prior = readPendingIntent(key, parse, storage);
  if (prior) return prior;
  storage.setItem(key, JSON.stringify(proposed));
  return proposed;
}
/** A late response may only retire the request it actually completed. */
export function clearPendingIntent(key: string, requestId: string, storage: Pick<Storage, 'getItem'|'removeItem'> = localStorage): void {
  const raw = storage.getItem(key);
  if (raw && JSON.parse(raw).requestId === requestId) storage.removeItem(key);
}

/** A retry's rejection cannot disprove an earlier commit with a lost response. */
export function canReplaceRejectedIntent(resuming: boolean, status: number): boolean {
  return !resuming && status >= 400 && status < 500 && status !== 408 && status !== 409;
}
