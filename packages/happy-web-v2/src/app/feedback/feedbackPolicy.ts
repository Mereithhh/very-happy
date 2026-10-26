/**
 * B-836 in-app feedback — the pure half on the web side
 * (`specs/2026-10-feedback.md`): when the occasional prompt card may show,
 * how active days are counted, and exactly which diagnostics a submission
 * carries. No React, no stores: FeedbackPromptCard and FeedbackForm feed it.
 */

export type FeedbackRating = 'good' | 'ok' | 'bad';
export const FEEDBACK_RATINGS: readonly FeedbackRating[] = ['good', 'ok', 'bad'];
export const FEEDBACK_TEXT_MAX = 2000;

/** First prompt after this many distinct days with the app open. */
export const FEEDBACK_PROMPT_MIN_ACTIVE_DAYS = 5;
/** At most one prompt per this many days, and none this long after a submission. */
export const FEEDBACK_PROMPT_INTERVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Synced (cross-device) prompt state — flat settings fields, see sync/settings.ts. */
export interface FeedbackPromptState {
  feedbackActiveDays: number;
  /** local calendar day (YYYY-MM-DD) last counted */
  feedbackLastActiveDay: string | null;
  /** epoch ms the card last showed (any device) */
  feedbackPromptShownAt: number | null;
  /** 不再提示 */
  feedbackPromptOptOut: boolean;
  /** epoch ms of the last submission from either the form or the card */
  feedbackLastSubmittedAt: number | null;
}

export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The settings patch that counts today, or null when today is already counted (one write per day). */
export function activeDayPatch(state: Pick<FeedbackPromptState, 'feedbackActiveDays' | 'feedbackLastActiveDay'>, now: number): Pick<FeedbackPromptState, 'feedbackActiveDays' | 'feedbackLastActiveDay'> | null {
  const today = localDay(now);
  if (state.feedbackLastActiveDay === today) return null;
  return { feedbackActiveDays: Math.max(0, state.feedbackActiveDays || 0) + 1, feedbackLastActiveDay: today };
}

export interface FeedbackPromptContext {
  /** release notes still unread on this device */
  pendingChangelog: boolean;
  /** opened by a deep link (B-697: those never get an uninvited overlay) */
  deepLink: boolean;
  /** already typing / tapping (B-823) */
  interacted: boolean;
}

export type FeedbackPromptBlock = 'opted-out' | 'new-user' | 'recently-shown' | 'recently-submitted' | 'changelog' | 'deep-link' | 'interacted';

/** Why the card may not show now; null = it may. Critical overlays are handled by the overlay queue itself. */
export function feedbackPromptBlock(state: FeedbackPromptState, ctx: FeedbackPromptContext, now: number): FeedbackPromptBlock | null {
  if (state.feedbackPromptOptOut) return 'opted-out';
  if ((state.feedbackActiveDays || 0) < FEEDBACK_PROMPT_MIN_ACTIVE_DAYS) return 'new-user';
  const interval = FEEDBACK_PROMPT_INTERVAL_DAYS * DAY_MS;
  if (state.feedbackPromptShownAt !== null && now - state.feedbackPromptShownAt < interval) return 'recently-shown';
  if (state.feedbackLastSubmittedAt !== null && now - state.feedbackLastSubmittedAt < interval) return 'recently-submitted';
  if (ctx.pendingChangelog) return 'changelog';
  if (ctx.deepLink) return 'deep-link';
  if (ctx.interacted) return 'interacted';
  return null;
}

export function feedbackPromptDue(state: FeedbackPromptState, ctx: FeedbackPromptContext, now: number): boolean {
  return feedbackPromptBlock(state, ctx, now) === null;
}

const ID_SEGMENT = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,})$/i;

/** Same rule as the server's `routePattern`: no query/hash, id-like segments → `:id`. */
export function routePattern(route: string): string {
  const path = route.split(/[?#]/, 1)[0] || '/';
  return path.split('/').map((seg) => (seg && ID_SEGMENT.test(seg) ? ':id' : seg)).join('/').slice(0, 200) || '/';
}

export interface FeedbackDiagnostics {
  webVersion: string;
  cliVersions: string[];
  userAgent: string;
  language: string;
  viewport: string;
  pointer: 'fine' | 'coarse' | 'none';
  route: string;
  timeZone: string;
  ts: string;
}

/**
 * Exactly what is sent when 附带诊断信息 is ticked — the form renders this
 * object verbatim. Machines contribute only their CLI version (deduped,
 * sorted): no names, hosts or paths. No session content, ever.
 */
export function buildFeedbackDiagnostics(input: {
  webVersion: string;
  cliVersions: readonly (string | null | undefined)[];
  userAgent: string;
  language: string;
  viewport: { width: number; height: number };
  pointer: 'fine' | 'coarse' | 'none';
  pathname: string;
  timeZone: string;
  now: number;
}): FeedbackDiagnostics {
  const cli = [...new Set(input.cliVersions.filter((v): v is string => typeof v === 'string' && v.length > 0).map((v) => v.slice(0, 32)))].sort().slice(0, 10);
  return {
    webVersion: input.webVersion.slice(0, 64),
    cliVersions: cli,
    userAgent: input.userAgent.slice(0, 400),
    language: input.language.slice(0, 32),
    viewport: `${Math.round(input.viewport.width)}x${Math.round(input.viewport.height)}`,
    pointer: input.pointer,
    route: routePattern(input.pathname),
    timeZone: input.timeZone.slice(0, 64),
    ts: new Date(input.now).toISOString(),
  };
}
