/**
 * B-651 UX telemetry for projects (`specs/2026-10-projects.md` 度量 ①②):
 * counts and durations only — no titles, ids or text leave the browser.
 * Batched (≤20 per POST, flushed every 10s or on hide); an older server (404)
 * or any failure just drops the batch and, on 404, switches reporting off.
 */
import { PROJECT_UX_DISPATCH_ENTRIES, type ProjectUxEvent } from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

const MAX_BATCH = 20;
const FLUSH_MS = 10_000;
let queue: ProjectUxEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let disabled = false;

export function reportProjectUx(event: ProjectUxEvent): void {
  if (disabled) return;
  queue.push(event);
  if (queue.length >= MAX_BATCH) void flushProjectUx();
  else if (!timer) timer = setTimeout(() => { void flushProjectUx(); }, FLUSH_MS);
}

export async function flushProjectUx(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const credentials = getCurrentAuth()?.credentials;
  if (!queue.length || !credentials || disabled) return;
  const events = queue.slice(0, MAX_BATCH);
  queue = queue.slice(MAX_BATCH);
  try {
    const response = await fetchImpl(`${getServerUrl()}/v1/projects/ux-events`, {
      method: 'POST', keepalive: true,
      headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (response.status === 404) { disabled = true; queue = []; }
  } catch { /* telemetry never surfaces */ }
  if (queue.length) timer = setTimeout(() => { void flushProjectUx(); }, FLUSH_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) void flushProjectUx(); });
}

const reportedAttention = new Set<string>();
/** ②: once per (session, waiting episode) — `attentionSince` identifies the episode. */
export function reportAttentionOpen(sessionKey: string, attentionSince: number | undefined, inProject: boolean, now = Date.now()): boolean {
  if (!attentionSince || attentionSince > now) return false;
  const key = `${sessionKey}:${attentionSince}`;
  if (reportedAttention.has(key)) return false;
  reportedAttention.add(key);
  if (reportedAttention.size > 500) reportedAttention.delete(reportedAttention.values().next().value as string);
  reportProjectUx({ kind: 'attention_open', latencyMs: Math.min(now - attentionSince, 7 * 86400_000), inProject });
  return true;
}

/** ①: map a pending-session source to the reported entry point. */
export function dispatchEntryOf(source: string): (typeof PROJECT_UX_DISPATCH_ENTRIES)[number] {
  return (PROJECT_UX_DISPATCH_ENTRIES as readonly string[]).includes(source) ? source as (typeof PROJECT_UX_DISPATCH_ENTRIES)[number] : 'other';
}

export const _forTests = { reset: () => { queue = []; disabled = false; reportedAttention.clear(); if (timer) clearTimeout(timer); timer = null; }, queue: () => queue, disabled: () => disabled };
