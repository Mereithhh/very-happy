import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactCliArgv, redactLogString, redactLogValue } from './logRedaction';

describe('log redaction', () => {
  it('removes nested credentials, environment values, and bearer strings', () => {
    const redacted = redactLogValue({
      token: 'vendor-secret',
      headers: { Authorization: 'Bearer account-secret' },
      config: {
        data: { apiKey: 'sk-live' },
        environmentVariables: { OPENAI_API_KEY: 'sk-env', SAFE_FLAG: '1' },
      },
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of ['vendor-secret', 'account-secret', 'sk-live', 'sk-env']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('OPENAI_API_KEY');
    expect(serialized).toContain('[REDACTED]');
  });

  it('reduces Axios-like errors to an allowlisted summary', () => {
    const error = Object.assign(new Error('Request failed with token=top-secret'), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      response: { status: 401, data: { token: 'response-secret' } },
      config: { headers: { Authorization: 'Bearer account-secret' } },
    });
    const serialized = JSON.stringify(redactLogValue(error));
    expect(serialized).toContain('ERR_BAD_REQUEST');
    expect(serialized).toContain('401');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('response-secret');
    expect(serialized).not.toContain('account-secret');
    expect(serialized).not.toContain('config');
  });

  it('redacts credentials embedded in plain text', () => {
    expect(redactLogString('Authorization: Bearer abc.def token=hello')).toBe(
      'Authorization: Bearer [REDACTED] token=[REDACTED]',
    );
  });
});

describe('startup argv redaction (B-874c, QA43 P2-4)', () => {
  const head = ['/usr/bin/node', '/opt/vh/bin/happy.mjs'];
  it('drops issue / todo text but keeps the command shape', () => {
    expect(redactCliArgv([...head, 'issue', 'comment', 'VH-12', 'secret plan for the launch'])).toEqual([...head, 'issue', 'comment', 'VH-12', '[redacted]']);
    expect(redactCliArgv([...head, 'issues', 'create', '--title', 'Fix login bug', '--priority=high', '--description=Users see 500'])).toEqual([...head, 'issues', 'create', '--title', '[redacted]', '--priority=[redacted]', '--description=[redacted]']);
    expect(redactCliArgv([...head, 'todo', 'add', '--id', '0b9d6c6e-1f0a-4d43-9a39-6a5d1c1b7e21', '--title', 'Buy milk', '--version', '3'])).toEqual([...head, 'todo', 'add', '--id', '0b9d6c6e-1f0a-4d43-9a39-6a5d1c1b7e21', '--title', '[redacted]', '--version', '3']);
    expect(redactCliArgv([...head, 'todo', 'add', 'Hello'])).toEqual([...head, 'todo', 'add', '[redacted]']);
  });
  it('leaves other commands as they were', () => {
    const argv = [...head, 'daemon', 'start'];
    expect(redactCliArgv(argv)).toEqual(argv);
    expect(redactCliArgv(head)).toEqual(head);
  });
});

describe('startup argv / title logging wiring (B-874c)', () => {
  const strip = (source: string) => source.replace(/^\s*\/\/.*$/gm, '');
  it('main logs the redacted argv and the MCP title change logs only a length', () => {
    const main = strip(readFileSync(join(__dirname, '../main.ts'), 'utf8'));
    expect(main).toContain("logger.debug('Starting happy CLI with args: ', redactCliArgv(process.argv))");
    expect(main).not.toContain("logger.debug('Starting happy CLI with args: ', process.argv)");
    const mcp = readFileSync(join(__dirname, '../claude/utils/startHappyServer.ts'), 'utf8');
    expect(mcp).toContain('logger.debug(`[happyMCP] Changing title (${title.length} chars)`);');
    expect(mcp).not.toContain("logger.debug('[happyMCP] Changing title to:', title);");
  });
});
