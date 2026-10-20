import { PROJECT_SESSION_CAPABILITY, type ProjectPresenceView } from '@slopus/happy-wire';

/**
 * B-648 pure rules for the project page (`specs/2026-10-projects.md` §6.2).
 * Kept apart from the screen so the badge semantics and the buckets are
 * unit-tested — the 等你处理 count must equal the sidebar header and /board.
 */

export type InjectionState =
  | { kind: 'current'; version: number }
  /** Injected an older instructions version; the next turn's digest catches up. */
  | { kind: 'stale'; version: number; latest: number }
  /** Wrapper can inject but has not run a turn since joining. */
  | { kind: 'pending' }
  /** No `project-v1`: an older wrapper (restart to enable) or a harness that cannot be injected. */
  | { kind: 'none'; restartHelps: boolean }
  /** Metadata not loaded yet (e.g. another machine's session this browser cannot decrypt). */
  | { kind: 'unknown' };

const INJECTABLE_FLAVORS = new Set(['claude', 'codex', 'gemini', 'pi', 'acp']);

/**
 * The truth for the 「已注入 vN / 旧版 / 未注入」 badge (准则 1): capability from
 * the session's own metadata (per session, never per machine — AGENTS rule 14),
 * version from the wrapper's presence report.
 */
export function injectionStateOf(
  meta: { capabilities?: string[]; flavor?: string | null } | null | undefined,
  presence: Pick<ProjectPresenceView, 'injectedInstructionsVersion' | 'capabilities'> | undefined,
  latestVersion: number,
): InjectionState {
  const caps = meta?.capabilities ?? presence?.capabilities;
  if (!meta && !presence) return { kind: 'unknown' };
  if (!caps?.includes(PROJECT_SESSION_CAPABILITY)) {
    const flavor = meta?.flavor ?? null;
    return { kind: 'none', restartHelps: !!flavor && INJECTABLE_FLAVORS.has(flavor) };
  }
  const injected = presence?.injectedInstructionsVersion;
  if (injected === null || injected === undefined) return { kind: 'pending' };
  if (injected >= latestVersion) return { kind: 'current', version: injected };
  return { kind: 'stale', version: injected, latest: latestVersion };
}

export interface InjectionSummary { current: number; stale: number; pending: number; none: number; unknown: number }
export function summarizeInjection(states: InjectionState[]): InjectionSummary {
  const out: InjectionSummary = { current: 0, stale: 0, pending: 0, none: 0, unknown: 0 };
  for (const s of states) out[s.kind]++;
  return out;
}

export type ProjectBucket = 'attention' | 'running' | 'idle';
/**
 * Overview buckets over the board's own classification: 等你处理 is exactly the
 * sidebar's `attentionKeysOf` set (so the numbers agree), 进行中 is the
 * board's running lifecycle, everything else is 空闲.
 */
export function bucketOf(item: { key: string; lifecycle: string }, attentionKeys: ReadonlySet<string>): ProjectBucket {
  if (attentionKeys.has(item.key)) return 'attention';
  if (item.lifecycle === 'running') return 'running';
  return 'idle';
}

export function bucketItems<T extends { key: string; lifecycle: string }>(items: T[], projectKeys: ReadonlySet<string>, attentionKeys: ReadonlySet<string>): Record<ProjectBucket, T[]> {
  const out: Record<ProjectBucket, T[]> = { attention: [], running: [], idle: [] };
  for (const item of items) if (projectKeys.has(item.key)) out[bucketOf(item, attentionKeys)].push(item);
  return out;
}

/** UTF-8 size guard matching the server's 8KB instructions cap. */
export const INSTRUCTIONS_MAX_BYTES = 8 * 1024;
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
