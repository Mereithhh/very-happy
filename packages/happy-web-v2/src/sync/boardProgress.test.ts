import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { BOARD_PROGRESS_STALE_MS, boardProgressView } from './boardProgress';

const NOW = 1_700_000_000_000;

describe('boardProgressView (B-556)', () => {
  it('fresh while live and updated within 30 min', () => {
    expect(boardProgressView({ progress: ' Running  tests ', phase: 'testing', analyzedAt: NOW - 60_000 }, { now: NOW, live: true }))
      .toEqual({ text: 'Running tests', phase: 'testing', updatedAt: NOW - 60_000, stale: false });
  });

  it('stale once the session is not running, or after 30 min, or without a timestamp', () => {
    expect(boardProgressView({ progress: 'x', analyzedAt: NOW }, { now: NOW, live: false })?.stale).toBe(true);
    expect(boardProgressView({ progress: 'x', analyzedAt: NOW - BOARD_PROGRESS_STALE_MS - 1 }, { now: NOW, live: true })?.stale).toBe(true);
    expect(boardProgressView({ progress: 'x', analyzedAt: NOW - BOARD_PROGRESS_STALE_MS }, { now: NOW, live: true })?.stale).toBe(false);
    expect(boardProgressView({ progress: 'x' }, { now: NOW, live: true })?.stale).toBe(true);
  });

  it('a CLI clock ahead of the browser is "just updated", not stale', () => {
    expect(boardProgressView({ progress: 'x', analyzedAt: NOW + 3_600_000 }, { now: NOW, live: true })?.stale).toBe(false);
  });

  it('unknown phases are kept as plain text (铁律 14); no progress → null', () => {
    const view = boardProgressView({ progress: 'x', phase: 'deploying', analyzedAt: NOW }, { now: NOW, live: true });
    expect(view?.phase).toBeUndefined();
    expect(view?.unknownPhase).toBe('deploying');
    expect(boardProgressView({ progress: '   ', analyzedAt: NOW }, { now: NOW, live: true })).toBeNull();
    expect(boardProgressView({ analyzedAt: NOW }, { now: NOW, live: true })).toBeNull();
    expect(boardProgressView(undefined, { now: NOW, live: true })).toBeNull();
  });
});

describe('metadata.board.phase schema compatibility (B-556)', () => {
  const base = { path: '/p', host: 'h' };

  it('keeps an unknown phase so a web metadata write does not strip it', () => {
    const parsed = MetadataSchema.parse({ ...base, board: { progress: 'p', phase: 'future-phase', analyzedAt: 1 } });
    expect(parsed.board?.phase).toBe('future-phase');
  });

  it('a malformed phase drops only that field, never the board or the metadata', () => {
    const parsed = MetadataSchema.parse({ ...base, summary: { text: 'title', updatedAt: 1 }, board: { progress: 'p', phase: 5, analyzedAt: 1 } });
    expect(parsed.board).toEqual({ progress: 'p', analyzedAt: 1 });
    expect(parsed.summary?.text).toBe('title');
  });

  it('absent stays absent (no default written back)', () => {
    expect('phase' in MetadataSchema.parse({ ...base, board: { analyzedAt: 1 } }).board!).toBe(false);
  });
});
