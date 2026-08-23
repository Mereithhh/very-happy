import { describe, expect, it } from 'vitest';
import { shouldShowFirstRun } from './firstRun';

describe('shouldShowFirstRun', () => {
  it('waits for hydration before deciding the account is new', () => {
    expect(shouldShowFirstRun(false, 0)).toBe(false);
  });

  it('shows only when the hydrated account has no registered machine', () => {
    expect(shouldShowFirstRun(true, 0)).toBe(true);
    expect(shouldShowFirstRun(true, 1)).toBe(false);
  });
});
