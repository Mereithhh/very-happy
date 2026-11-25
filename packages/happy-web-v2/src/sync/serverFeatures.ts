/**
 * B-974g: what `GET /v1/features` says this account has (`{ features: string[] }`).
 * Pure store, no app imports: the public pages read it too (signed out = none).
 * Fails closed: not loaded, 404, an error or another shape all mean "none".
 * Loaded by ServerFeaturesSync.
 */
import { useSyncExternalStore } from 'react';

const NONE: readonly string[] = [];
let features: readonly string[] = NONE;
const listeners = new Set<() => void>();

export function getServerFeatures(): readonly string[] {
  return features;
}

export function setServerFeatures(next: readonly string[]): void {
  if (next.length === features.length && next.every((f, i) => f === features[i])) return;
  features = next.length > 0 ? [...next] : NONE;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useServerFeatures(): readonly string[] {
  return useSyncExternalStore(subscribe, getServerFeatures, getServerFeatures);
}

export function parseServerFeatures(body: unknown): readonly string[] {
  const list = body && typeof body === 'object' ? (body as { features?: unknown }).features : null;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : NONE;
}

/** `retry`: no answer from the server (network, 5xx) — worth asking again; 404 = an older server, final. */
export async function fetchServerFeatures(serverUrl: string, token: string): Promise<{ features: readonly string[]; retry: boolean }> {
  try {
    const response = await fetch(`${serverUrl}/v1/features`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return { features: NONE, retry: response.status >= 500 || response.status === 429 };
    return { features: parseServerFeatures(await response.json()), retry: false };
  } catch {
    return { features: NONE, retry: true };
  }
}
