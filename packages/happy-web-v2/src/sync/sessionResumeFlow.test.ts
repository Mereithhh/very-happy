import { describe, expect, it, vi } from 'vitest';
import { commitSessionResume } from './sessionResumeFlow';

describe('commitSessionResume', () => {
  it('unarchives before starting and leaves a successful session unarchived', async () => {
    const calls: string[] = [];
    const result = await commitSessionResume(
      async () => { calls.push('unarchive'); return { success: true, supported: true }; },
      async () => { calls.push('resume'); return { type: 'success', sessionId: 'session-1' }; },
      async () => { calls.push('rearchive'); return { success: true }; },
    );
    expect(result).toEqual({ type: 'success', sessionId: 'session-1' });
    expect(calls).toEqual(['unarchive', 'resume']);
  });

  it('awaits archive compensation when spawning fails', async () => {
    const rearchive = vi.fn(async () => ({ success: true }));
    const result = await commitSessionResume(
      async () => ({ success: true, supported: true }),
      async () => ({ type: 'error', errorMessage: 'daemon offline' }),
      rearchive,
    );
    expect(rearchive).toHaveBeenCalledOnce();
    expect(result).toEqual({ type: 'error', errorMessage: 'daemon offline' });
  });

  it('B-265: folds a thrown daemon handler ({error}) into an error result and still compensates', async () => {
    const rearchive = vi.fn(async () => ({ success: true }));
    const result = await commitSessionResume(
      async () => ({ success: true, supported: true }),
      async () => ({ error: 'resume-precheck:not-tracked' } as any),
      rearchive,
    );
    expect(rearchive).toHaveBeenCalledOnce();
    expect(result).toEqual({ type: 'error', errorMessage: 'resume-precheck:not-tracked' });
  });

  it('preserves compatibility with a server that has no lifecycle endpoint', async () => {
    const rearchive = vi.fn(async () => ({ success: true }));
    await commitSessionResume(
      async () => ({ success: true, supported: false }),
      async () => ({ type: 'error', errorMessage: 'old daemon' }),
      rearchive,
    );
    expect(rearchive).not.toHaveBeenCalled();
  });
});
