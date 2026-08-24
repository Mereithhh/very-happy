import { describe, expect, it } from 'vitest';
import { buildResumeCommandBlock } from './resumeCommand';

describe('resume command', () => {
  it('copies the published Very Happy binary for Claude and Codex', () => {
    expect(buildResumeCommandBlock({ flavor: 'claude', claudeSessionId: 'claude-1' })?.copyText)
      .toBe('very-happy claude --resume claude-1');
    expect(buildResumeCommandBlock({ flavor: 'codex', codexThreadId: 'codex-1', path: '/tmp/work' })?.copyText)
      .toBe("cd '/tmp/work'\nvery-happy codex --resume codex-1");
  });
});
