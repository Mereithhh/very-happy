import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { SELF_STATUS_STALE_MS, boardStatusLine, selfStatusView } from './selfStatus';

const NOW = 1_700_000_000_000;

describe('selfStatusView (B-556)', () => {
  it('fresh while live and updated within 30 min', () => {
    expect(selfStatusView({ text: ' Running  tests ', phase: 'testing', updatedAt: NOW - 60_000 }, { now: NOW, live: true }))
      .toEqual({ text: 'Running tests', phase: 'testing', updatedAt: NOW - 60_000, stale: false });
  });

  it('stale once the session is not running, or after 30 min', () => {
    expect(selfStatusView({ text: 'x', updatedAt: NOW }, { now: NOW, live: false })?.stale).toBe(true);
    expect(selfStatusView({ text: 'x', updatedAt: NOW - SELF_STATUS_STALE_MS - 1 }, { now: NOW, live: true })?.stale).toBe(true);
    expect(selfStatusView({ text: 'x', updatedAt: NOW - SELF_STATUS_STALE_MS }, { now: NOW, live: true })?.stale).toBe(false);
  });

  it('a CLI clock ahead of the browser is "just updated", not stale', () => {
    expect(selfStatusView({ text: 'x', updatedAt: NOW + 3_600_000 }, { now: NOW, live: true })?.stale).toBe(false);
  });

  it('unknown phases are kept as plain text (铁律 14), bad shapes yield null', () => {
    const view = selfStatusView({ text: 'x', phase: 'deploying', updatedAt: NOW }, { now: NOW, live: true });
    expect(view?.phase).toBeUndefined();
    expect(view?.unknownPhase).toBe('deploying');
    expect(selfStatusView({ text: '   ', updatedAt: NOW }, { now: NOW, live: true })).toBeNull();
    expect(selfStatusView({ text: 'x', updatedAt: 'soon' }, { now: NOW, live: true })).toBeNull();
    expect(selfStatusView(undefined, { now: NOW, live: true })).toBeNull();
  });
});

describe('boardStatusLine (B-556)', () => {
  const fresh = selfStatusView({ text: 'self', updatedAt: NOW - 1_000 }, { now: NOW, live: true });
  const stale = selfStatusView({ text: 'self', updatedAt: NOW - 1_000 }, { now: NOW, live: false });

  it('fresh self status beats LLM progress; old CLIs keep their progress line', () => {
    expect(boardStatusLine(fresh, { text: 'llm', analyzedAt: NOW })).toMatchObject({ kind: 'self' });
    expect(boardStatusLine(null, { text: 'llm', analyzedAt: NOW })).toEqual({ kind: 'progress', text: 'llm' });
    expect(boardStatusLine(null, undefined)).toBeNull();
  });

  it('stale self status yields to newer progress, else stays (de-emphasized)', () => {
    expect(boardStatusLine(stale, { text: 'llm', analyzedAt: NOW })).toEqual({ kind: 'progress', text: 'llm' });
    expect(boardStatusLine(stale, { text: 'llm', analyzedAt: NOW - 60_000 })).toMatchObject({ kind: 'self', status: { stale: true } });
  });
});

describe('metadata schema compatibility (B-556)', () => {
  const base = { path: '/p', host: 'h' };

  it('keeps selfStatus with an unknown phase so a web metadata write does not strip it', () => {
    const parsed = MetadataSchema.parse({ ...base, selfStatus: { text: 't', phase: 'future-phase', updatedAt: 1 } });
    expect(parsed.selfStatus).toEqual({ text: 't', phase: 'future-phase', updatedAt: 1 });
  });

  it('a malformed selfStatus drops only that field, never the whole metadata', () => {
    const parsed = MetadataSchema.parse({ ...base, summary: { text: 'title', updatedAt: 1 }, selfStatus: { text: 5 } });
    expect(parsed.selfStatus).toBeUndefined();
    expect(parsed.summary?.text).toBe('title');
  });

  it('absent stays absent (no default written back)', () => {
    expect('selfStatus' in MetadataSchema.parse(base)).toBe(false);
  });
});
