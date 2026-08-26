import { describe, expect, it } from 'vitest';
import { toastDurationMs } from './Toast';

describe('toastDurationMs', () => {
  it('keeps copy-style success feedback brief while preserving errors', () => {
    expect(toastDurationMs('success')).toBe(1_800);
    expect(toastDurationMs('error')).toBe(4_000);
    expect(toastDurationMs('info')).toBe(4_000);
  });
});
