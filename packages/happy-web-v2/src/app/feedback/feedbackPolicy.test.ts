import { describe, expect, it } from 'vitest';
import {
  activeDayPatch, buildFeedbackDiagnostics, feedbackChangelogWaitMs, feedbackPromptBlock, feedbackPromptDue, isFreshEscape, localDay, routePattern,
  FEEDBACK_AFTER_CHANGELOG_MS, FEEDBACK_PROMPT_INTERVAL_DAYS, FEEDBACK_PROMPT_MIN_ACTIVE_DAYS, type FeedbackPromptState,
} from './feedbackPolicy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const ready: FeedbackPromptState = {
  feedbackActiveDays: FEEDBACK_PROMPT_MIN_ACTIVE_DAYS,
  feedbackLastActiveDay: localDay(NOW),
  feedbackPromptShownAt: null,
  feedbackPromptOptOut: false,
  feedbackLastSubmittedAt: null,
};
const quiet = { pendingChangelog: false, changelogOpen: false, changelogClosedAt: null as number | null, deepLink: false, interacted: false };

describe('feedback prompt policy (B-836)', () => {
  it('counts one active day per local calendar day', () => {
    expect(activeDayPatch({ feedbackActiveDays: 0, feedbackLastActiveDay: null }, NOW)).toEqual({ feedbackActiveDays: 1, feedbackLastActiveDay: '2026-10-27' });
    expect(activeDayPatch({ feedbackActiveDays: 3, feedbackLastActiveDay: '2026-10-27' }, NOW)).toBeNull();
    expect(activeDayPatch({ feedbackActiveDays: 3, feedbackLastActiveDay: '2026-10-26' }, NOW)).toEqual({ feedbackActiveDays: 4, feedbackLastActiveDay: '2026-10-27' });
    // a garbage count from an old client restarts at 1 instead of NaN
    expect(activeDayPatch({ feedbackActiveDays: -2, feedbackLastActiveDay: null }, NOW)?.feedbackActiveDays).toBe(1);
  });

  it('may show once active days are reached and nothing blocks it', () => {
    expect(feedbackPromptBlock(ready, quiet, NOW)).toBeNull();
    expect(feedbackPromptDue(ready, quiet, NOW)).toBe(true);
  });

  it('each rule blocks on its own', () => {
    const cases: Array<[Partial<FeedbackPromptState>, Partial<typeof quiet>, string]> = [
      [{ feedbackPromptOptOut: true }, {}, 'opted-out'],
      [{ feedbackActiveDays: FEEDBACK_PROMPT_MIN_ACTIVE_DAYS - 1 }, {}, 'new-user'],
      [{ feedbackPromptShownAt: NOW - (FEEDBACK_PROMPT_INTERVAL_DAYS * DAY - 1) }, {}, 'recently-shown'],
      [{ feedbackLastSubmittedAt: NOW - 3 * DAY }, {}, 'recently-submitted'],
      [{}, { pendingChangelog: true }, 'changelog'],
      [{}, { deepLink: true }, 'deep-link'],
      [{}, { interacted: true }, 'interacted'],
    ];
    for (const [state, ctx, block] of cases) {
      expect(feedbackPromptBlock({ ...ready, ...state }, { ...quiet, ...ctx }, NOW)).toBe(block);
    }
  });

  it('B-857: two active days are enough', () => {
    expect(FEEDBACK_PROMPT_MIN_ACTIVE_DAYS).toBe(2);
    expect(feedbackPromptBlock({ ...ready, feedbackActiveDays: 2 }, quiet, NOW)).toBeNull();
    expect(feedbackPromptBlock({ ...ready, feedbackActiveDays: 1 }, quiet, NOW)).toBe('new-user');
  });

  it('B-857: unread release notes queue the card behind them — 20 s after they close, read or not', () => {
    expect(FEEDBACK_AFTER_CHANGELOG_MS).toBe(20_000);
    // notes unread and not closed yet (open, or still to come): wait, with no known end
    expect(feedbackPromptBlock(ready, { ...quiet, pendingChangelog: true }, NOW)).toBe('changelog');
    expect(feedbackChangelogWaitMs({ changelogOpen: false, changelogClosedAt: null }, NOW)).toBeNull();
    // read to the end (nothing pending) or closed on the last page (still pending): 20 s later
    for (const pendingChangelog of [false, true]) {
      const closed = { ...quiet, pendingChangelog, changelogClosedAt: NOW - FEEDBACK_AFTER_CHANGELOG_MS + 1 };
      expect(feedbackPromptBlock(ready, closed, NOW)).toBe('changelog');
      expect(feedbackChangelogWaitMs(closed, NOW)).toBe(1);
      expect(feedbackPromptBlock(ready, { ...closed, changelogClosedAt: NOW - FEEDBACK_AFTER_CHANGELOG_MS }, NOW)).toBeNull();
    }
    // the other guards still win after the notes
    const after = { ...quiet, changelogClosedAt: NOW - DAY };
    expect(feedbackPromptBlock(ready, { ...after, deepLink: true }, NOW)).toBe('deep-link');
    expect(feedbackPromptBlock({ ...ready, feedbackPromptOptOut: true }, after, NOW)).toBe('opted-out');
    expect(feedbackPromptBlock({ ...ready, feedbackLastSubmittedAt: NOW - DAY }, after, NOW)).toBe('recently-submitted');
  });

  it('B-857b: notes reopened inside the wait hold the card again — with no known end — until the next close', () => {
    const reopened = { ...quiet, pendingChangelog: true, changelogOpen: true, changelogClosedAt: NOW - FEEDBACK_AFTER_CHANGELOG_MS - 1 };
    expect(feedbackPromptBlock(ready, reopened, NOW)).toBe('changelog');
    expect(feedbackChangelogWaitMs(reopened, NOW)).toBeNull();
    // even with nothing left pending (read up to the last page): open is open
    expect(feedbackPromptBlock(ready, { ...reopened, pendingChangelog: false }, NOW)).toBe('changelog');
    // closed again: a fresh 20 s from that close
    const closedAgain = { ...reopened, changelogOpen: false, changelogClosedAt: NOW };
    expect(feedbackChangelogWaitMs(closedAgain, NOW)).toBe(FEEDBACK_AFTER_CHANGELOG_MS);
    expect(feedbackPromptBlock(ready, closedAgain, NOW + FEEDBACK_AFTER_CHANGELOG_MS)).toBeNull();
  });

  it('B-857b: Esc closes the card only when it is the card\'s — not one handled above it or sent before it mounted', () => {
    const esc = (timeStamp: number, defaultPrevented = false) => ({ key: 'Escape', defaultPrevented, timeStamp });
    expect(isFreshEscape(esc(1001), 1000)).toBe(true);
    expect(isFreshEscape(esc(1000), 1000)).toBe(true);
    expect(isFreshEscape(esc(999), 1000)).toBe(false); // the Esc that closed ⌘K, still bubbling
    expect(isFreshEscape(esc(1001, true), 1000)).toBe(false);
    expect(isFreshEscape({ key: 'Enter', defaultPrevented: false, timeStamp: 1001 }, 1000)).toBe(false);
  });

  it('30 days after the last showing / submission it may ask again', () => {
    const later = { ...ready, feedbackPromptShownAt: NOW - FEEDBACK_PROMPT_INTERVAL_DAYS * DAY, feedbackLastSubmittedAt: NOW - FEEDBACK_PROMPT_INTERVAL_DAYS * DAY };
    expect(feedbackPromptDue(later, quiet, NOW)).toBe(true);
  });

  it('route pattern matches the server rule: no query/hash, ids → :id', () => {
    expect(routePattern('/session/cmvph7gqg03ifrz2uk2cweyto?panel=board#m1')).toBe('/session/:id');
    expect(routePattern('/teams/529e51396854697d741b90c9877109514c8610102a7d93105b9fa735ddf761b2')).toBe('/teams/:id');
    expect(routePattern('/machine/8800f02a-f4a4-4d0e-ba6d-79cb3790da0c')).toBe('/machine/:id');
    expect(routePattern('/settings/appearance')).toBe('/settings/appearance');
  });

  it('diagnostics carry exactly the whitelisted fields; machines only as deduped CLI versions', () => {
    const d = buildFeedbackDiagnostics({
      webVersion: '2.1.0',
      cliVersions: ['0.2.190', '0.2.188', '0.2.190', null, undefined, ''],
      userAgent: 'UA',
      language: 'zh-CN',
      viewport: { width: 390.4, height: 844 },
      pointer: 'coarse',
      pathname: '/session/cmvph7gqg03ifrz2uk2cweyto',
      timeZone: 'Asia/Singapore',
      now: Date.UTC(2026, 9, 26, 16, 0),
    });
    expect(d).toEqual({
      webVersion: '2.1.0',
      cliVersions: ['0.2.188', '0.2.190'],
      userAgent: 'UA',
      language: 'zh-CN',
      viewport: '390x844',
      pointer: 'coarse',
      route: '/session/:id',
      timeZone: 'Asia/Singapore',
      ts: '2026-10-26T16:00:00.000Z',
    });
  });
});
