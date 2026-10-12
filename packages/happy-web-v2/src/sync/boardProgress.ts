/**
 * B-556 — reading the agent's self-reported status (`metadata.selfStatus`,
 * written by the CLI `set_status` MCP tool; spec 2026-10-agent-set-status §3).
 *
 * Display only: it never decides running/waiting (that stays with
 * agentLiveness.ts / agentStatus.ts). `live` is passed in from the existing
 * classification, so this module adds no second liveness judgement.
 */

/** Phases the CLI tool offers. Anything else is shown verbatim (铁律 14). */
export const KNOWN_SELF_STATUS_PHASES = ['planning', 'implementing', 'testing', 'reviewing', 'blocked', 'done'] as const;
export type KnownSelfStatusPhase = typeof KNOWN_SELF_STATUS_PHASES[number];

/** Older than this, or reported by a session that is no longer running → de-emphasized. */
export const SELF_STATUS_STALE_MS = 30 * 60 * 1000;

export interface SelfStatusView {
  text: string;
  /** known phase → i18n label; `unknownPhase` → shown as raw text */
  phase?: KnownSelfStatusPhase;
  unknownPhase?: string;
  updatedAt: number;
  stale: boolean;
}

export function isKnownSelfStatusPhase(value: unknown): value is KnownSelfStatusPhase {
  return typeof value === 'string' && (KNOWN_SELF_STATUS_PHASES as readonly string[]).includes(value);
}

export function selfStatusView(
  raw: { text?: unknown; phase?: unknown; updatedAt?: unknown } | null | undefined,
  opts: { now: number; live: boolean },
): SelfStatusView | null {
  if (!raw || typeof raw.text !== 'string' || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  const text = raw.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // A CLI clock ahead of the browser reads as "just updated", never as stale.
  const age = Math.max(0, opts.now - raw.updatedAt);
  const view: SelfStatusView = { text, updatedAt: raw.updatedAt, stale: !opts.live || age > SELF_STATUS_STALE_MS };
  if (isKnownSelfStatusPhase(raw.phase)) view.phase = raw.phase;
  else if (typeof raw.phase === 'string' && raw.phase.trim()) view.unknownPhase = raw.phase.trim().slice(0, 32);
  return view;
}

/**
 * Card line choice between the agent's own status and the daemon's LLM
 * `board.progress` (old CLIs only have the latter): a fresh self status wins;
 * otherwise the newer of the two, the self status de-emphasized.
 */
export function boardStatusLine(
  self: SelfStatusView | null,
  progress: { text?: string; analyzedAt?: number } | undefined,
): { kind: 'self'; status: SelfStatusView } | { kind: 'progress'; text: string } | null {
  const progressText = progress?.text?.trim();
  if (self && !self.stale) return { kind: 'self', status: self };
  if (progressText && (!self || (progress?.analyzedAt ?? 0) > self.updatedAt)) return { kind: 'progress', text: progressText };
  return self ? { kind: 'self', status: self } : null;
}
