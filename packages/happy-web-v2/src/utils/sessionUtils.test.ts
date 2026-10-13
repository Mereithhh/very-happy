import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { getSessionSidebarSubtitle } from './sessionUtils';

vi.mock('@/text', () => ({ t: () => 'unknown' }));

function session(metadata: Session['metadata']): Session {
  return {
    id: 'session-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    metadata,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 1,
    presence: 'online',
  };
}

describe('getSessionSidebarSubtitle', () => {
  it('identifies machine, agent, and project in the account-level sidebar', () => {
    expect(getSessionSidebarSubtitle(session({
      host: 'office',
      flavor: 'codex',
      path: '/Users/demo/very-happy',
      homeDir: '/Users/demo',
    }))).toBe('office · codex · ~/very-happy');
  });

  it('uses Claude for legacy sessions without a flavor', () => {
    expect(getSessionSidebarSubtitle(session({
      host: 'build',
      path: '/srv/app',
    }))).toBe('build · claude · /srv/app');
  });

  it('B-586: a worktree session also names its branch', () => {
    expect(getSessionSidebarSubtitle(session({
      host: 'office',
      flavor: 'claude',
      path: '/Users/demo/repo.worktrees/vh-swift-river',
      homeDir: '/Users/demo',
      worktree: { branch: 'vh/swift-river', root: '/Users/demo/repo.worktrees/vh-swift-river' },
    }))).toBe('office · claude · ~/repo.worktrees/vh-swift-river · ⎇ vh/swift-river');
  });
});
