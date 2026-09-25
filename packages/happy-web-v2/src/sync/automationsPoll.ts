/**
 * B-504: the Automations poll / entry-visibility state machine, as pure
 * functions so the sidebar bug class has a regression test that does not
 * need a browser.
 *
 * Incident (2026-09-25, veryhappy.dev @47605f538): the sidebar 「自动化」 entry
 * was gone for the Owner although `GET /v1/automations` answered 200 and the
 * bundle had the code. The entry rendered only on `enabled === true`, which
 * only ONE successful poll could set; the first poll ran in a mount effect
 * before `AuthProvider` had published the credentials (child effects run
 * before parent effects), threw a local 401 without a request, and the next
 * chance was a 60 s tick that is skipped while the tab is hidden. A tab
 * opened in the background therefore never showed the entry (291 s observed).
 *
 * Contract:
 *  - the entry is visible unless the server explicitly said
 *    `automations_disabled` (the feature is open to every account, B-502);
 *    `null` (not asked yet / non-gate errors) only hides the badge;
 *  - a `disabled` answer slows polling down instead of stopping it, so an
 *    env flip during a deploy cannot hide the feature for the page's lifetime;
 *  - a poll never runs before the credentials exist; it waits and retries
 *    shortly instead of counting a local 401 as the attempt.
 */

/** the server gate as the store keeps it: null = unknown, false = 404 automations_disabled */
export type AutomationsGate = boolean | null;

/** how often a page re-asks the server after `automations_disabled` */
export const AUTOMATIONS_DISABLED_RECHECK_MS = 5 * 60_000;
/** how soon a poll retries when the credentials were not published yet */
export const AUTOMATIONS_AUTH_RETRY_MS = 1_000;
/** upper bound on those retries per mount (logged-out harness, dev pages) */
export const AUTOMATIONS_AUTH_RETRY_LIMIT = 30;

/** sidebar / board entry: shown unless the server explicitly turned the feature off */
export function automationsEntryVisible(enabled: AutomationsGate): boolean {
  return enabled !== false;
}

/** poll cadence: the caller's interval, or the slow recheck once the server said disabled */
export function automationsPollIntervalMs(enabled: AutomationsGate, baseMs: number): number {
  return enabled === false ? Math.max(baseMs, AUTOMATIONS_DISABLED_RECHECK_MS) : baseMs;
}

export type AutomationsTick = 'mount' | 'interval' | 'resume' | 'auth-retry';
export type AutomationsTickPlan = 'refresh' | 'skip' | 'wait-auth';

export interface AutomationsTickContext {
  enabled: AutomationsGate;
  /** `getCurrentAuth()?.credentials` exists */
  authReady: boolean;
  /** `document.hidden` */
  hidden: boolean;
  /** auth retries already spent on this mount */
  authRetries: number;
}

/**
 * What a tick should do. `wait-auth` means: schedule an `auth-retry` tick in
 * `AUTOMATIONS_AUTH_RETRY_MS` (bounded by `AUTOMATIONS_AUTH_RETRY_LIMIT`).
 */
export function planAutomationsTick(kind: AutomationsTick, ctx: AutomationsTickContext): AutomationsTickPlan {
  if (!ctx.authReady) return ctx.authRetries < AUTOMATIONS_AUTH_RETRY_LIMIT ? 'wait-auth' : 'skip';
  // The gate flipping to `false` changes the interval and re-runs the mount
  // tick; do not ask again right after the 404 — the slow interval will.
  if (kind === 'mount' && ctx.enabled === false) return 'skip';
  if (kind === 'interval' && ctx.hidden) return 'skip';
  return 'refresh';
}
