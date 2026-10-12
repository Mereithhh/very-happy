/**
 * B-556 — reading the board progress line (`metadata.board`: `progress`,
 * optional `phase`, `analyzedAt`). Its only writers stay the two existing ones:
 * the agent's `report_progress` (now on every managed runner) and the daemon's
 * boardAnalyzer — no third writer (ux-review 2026-09 README §T-03 mitigation).
 *
 * Display only: it never decides running/waiting (agentLiveness.ts /
 * agentStatus.ts do). `live` is passed in from the existing classification.
 */

/** Phases `report_progress` offers. Anything else is shown verbatim (铁律 14). */
export const KNOWN_BOARD_PHASES = ['planning', 'implementing', 'testing', 'reviewing', 'blocked', 'done'] as const;
export type KnownBoardPhase = typeof KNOWN_BOARD_PHASES[number];

/** Older than this, or on a session that is no longer running → de-emphasized. */
export const BOARD_PROGRESS_STALE_MS = 30 * 60 * 1000;

export interface BoardProgressView {
  text: string;
  /** known phase → i18n label; `unknownPhase` → shown as raw text */
  phase?: KnownBoardPhase;
  unknownPhase?: string;
  /** `board.analyzedAt`; absent on malformed data → treated as stale */
  updatedAt?: number;
  stale: boolean;
}

export function isKnownBoardPhase(value: unknown): value is KnownBoardPhase {
  return typeof value === 'string' && (KNOWN_BOARD_PHASES as readonly string[]).includes(value);
}

export function boardProgressView(
  board: { progress?: unknown; phase?: unknown; analyzedAt?: unknown } | null | undefined,
  opts: { now: number; live: boolean },
): BoardProgressView | null {
  if (!board || typeof board.progress !== 'string') return null;
  const text = board.progress.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const updatedAt = typeof board.analyzedAt === 'number' && Number.isFinite(board.analyzedAt) ? board.analyzedAt : undefined;
  // A CLI clock ahead of the browser reads as "just updated", never as stale.
  const age = updatedAt === undefined ? Infinity : Math.max(0, opts.now - updatedAt);
  const view: BoardProgressView = { text, stale: !opts.live || age > BOARD_PROGRESS_STALE_MS };
  if (updatedAt !== undefined) view.updatedAt = updatedAt;
  if (isKnownBoardPhase(board.phase)) view.phase = board.phase;
  else if (typeof board.phase === 'string' && board.phase.trim()) view.unknownPhase = board.phase.trim().slice(0, 32);
  return view;
}
