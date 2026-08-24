import { describe, expect, it } from 'vitest';
import { summarizeSpawnSessionForLog } from './spawnSessionLog';

describe('summarizeSpawnSessionForLog', () => {
  it('records capability facts without credential, environment, or path values', () => {
    const summary = summarizeSpawnSessionForLog({
      agent: 'codex',
      sessionId: 'session-1',
      directory: '/private/customer/project',
      token: 'super-secret-bearer',
      environmentVariables: { OPENAI_API_KEY: 'sk-secret', SAFE_FLAG: '1' },
      resumeCodexThreadId: 'thread-secret-ish',
      forceNew: true,
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      agent: 'codex',
      sessionId: 'session-1',
      hasDirectory: true,
      hasToken: true,
      environmentVariableNames: ['OPENAI_API_KEY', 'SAFE_FLAG'],
      resumesCodex: true,
      forceNew: true,
    });
    expect(serialized).not.toContain('super-secret-bearer');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('/private/customer/project');
    expect(serialized).not.toContain('thread-secret-ish');
  });
});
