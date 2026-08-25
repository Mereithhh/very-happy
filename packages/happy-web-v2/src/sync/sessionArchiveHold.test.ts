import { afterEach, describe, expect, it } from 'vitest';
import {
  applySessionInactiveHold,
  holdSessionInactive,
  releaseSessionInactive,
  resetSessionInactiveHoldsForTest,
} from './sessionArchiveHold';

afterEach(resetSessionInactiveHoldsForTest);

describe('session archive activity hold', () => {
  it('masks a raced online update during archive cleanup', () => {
    holdSessionInactive('s1', 1_000);
    expect(applySessionInactiveHold({ id: 's1', active: true }, 1_001).active).toBe(false);
  });

  it('expires so a later explicit resume is visible', () => {
    holdSessionInactive('s1', 1_000);
    expect(applySessionInactiveHold({ id: 's1', active: true }, 6_001).active).toBe(true);
  });

  it('releases immediately when an archive attempt rolls back', () => {
    holdSessionInactive('s1', 1_000);
    releaseSessionInactive('s1');
    expect(applySessionInactiveHold({ id: 's1', active: true }, 1_001).active).toBe(true);
  });
});
