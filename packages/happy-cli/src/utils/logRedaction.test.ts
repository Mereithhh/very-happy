import { describe, expect, it } from 'vitest';
import { redactLogString, redactLogValue } from './logRedaction';

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
