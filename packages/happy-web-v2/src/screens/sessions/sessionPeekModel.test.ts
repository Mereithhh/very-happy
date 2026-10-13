// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { PEEK_BRANCH_TTL_MS, PEEK_HOVER_DELAY_MS, PEEK_HOVER_MEDIA, cachedBranch, lookupBranch, parseBranch, peekFacts, resetBranchCache } from './sessionPeekModel';

function session(over: Omit<Partial<Session>, 'metadata'> & { metadata?: Partial<NonNullable<Session['metadata']>> } = {}): Session {
  const { metadata, ...rest } = over;
  return {
    id: 's1', seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
    metadata: { path: '/home/me/code/app', host: 'mac-office', homeDir: '/home/me', ...metadata } as Session['metadata'],
    metadataVersion: 0, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence: 'online',
    ...rest,
  } as Session;
}

describe('session peek model (B-588)', () => {
  beforeEach(() => resetBranchCache());

  it('hover rules: fine hover-capable pointers only, 600ms', () => {
    expect(PEEK_HOVER_DELAY_MS).toBe(600);
    expect(PEEK_HOVER_MEDIA).toBe('(hover: hover) and (pointer: fine)');
  });

  it('facts: machine, ~path, running model (CLI-reported first), pending requests', () => {
    const facts = peekFacts(session({
      metadata: { currentModelCode: 'claude-opus-5' },
      latestUsage: { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, contextSize: 0, model: 'claude-sonnet-5', timestamp: 0 },
      agentState: { requests: { a: { tool: 'Bash', arguments: {} }, b: { tool: 'Edit', arguments: {} } } } as unknown as Session['agentState'],
    }));
    expect(facts).toEqual({ machine: 'mac-office', path: '~/code/app', model: 'opus-5', pending: 2 });
    expect(peekFacts(session({ latestUsage: { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, contextSize: 0, model: 'gpt-5.5', timestamp: 0 } })).model).toBe('gpt-5.5');
    expect(peekFacts(session()).model).toBeUndefined();
    // B-586 worktree sessions name their branch in metadata (no RPC needed)
    expect(peekFacts(session({ metadata: { worktree: { branch: 'feat/x', root: '/r' } } })).branch).toBe('feat/x');
    expect(peekFacts(session()).branch).toBeUndefined();
  });

  it('parses a branch; detached HEAD and empty output are not a branch', () => {
    expect(parseBranch('feat/x\n')).toBe('feat/x');
    expect(parseBranch('HEAD\n')).toBeUndefined();
    expect(parseBranch('')).toBeUndefined();
  });

  it('branch lookup: inactive sessions never call the RPC; results (and failures) are cached for the TTL', async () => {
    const run = vi.fn(async () => ({ success: true, exitCode: 0, stdout: 'main\n' }));
    expect(await lookupBranch('s1', { active: false, path: '/p' }, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();

    expect(await lookupBranch('s1', { active: true, path: '/p', now: 1_000 }, run)).toBe('main');
    expect(await lookupBranch('s1', { active: true, path: '/p', now: 2_000 }, run)).toBe('main');
    expect(run).toHaveBeenCalledTimes(1);
    expect(cachedBranch('s1')).toBe('main');

    const failing = vi.fn(async () => { throw new Error('rpc'); });
    expect(await lookupBranch('s2', { active: true, path: '/p' }, failing)).toBeUndefined();
    expect(await lookupBranch('s2', { active: true, path: '/p' }, failing)).toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);

    expect(await lookupBranch('s1', { active: true, path: '/p', now: Date.now() + PEEK_BRANCH_TTL_MS + 1 }, run)).toBe('main');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('concurrent opens share one in-flight lookup', async () => {
    let resolve!: (v: { success: boolean; exitCode: number; stdout: string }) => void;
    const run = vi.fn(() => new Promise<{ success: boolean; exitCode: number; stdout: string }>((r) => { resolve = r; }));
    const a = lookupBranch('s3', { active: true, path: '/p' }, run);
    const b = lookupBranch('s3', { active: true, path: '/p' }, run);
    resolve({ success: true, exitCode: 0, stdout: 'dev' });
    expect(await a).toBe('dev');
    expect(await b).toBe('dev');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
