import { describe, expect, it } from 'vitest';
import {
  activeDayPatch, buildFeedbackDiagnostics, feedbackPromptBlock, feedbackPromptDue, localDay, routePattern,
  FEEDBACK_PROMPT_INTERVAL_DAYS, FEEDBACK_PROMPT_MIN_ACTIVE_DAYS, type FeedbackPromptState,
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
const quiet = { pendingChangelog: false, deepLink: false, interacted: false };

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
