export type PasswordLoginFailure = 'invalid-credentials' | 'rate-limited' | 'network';

export function classifyPasswordLoginFailure(error: unknown): PasswordLoginFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'invalid-credentials') return 'invalid-credentials';
  if (code === 'rate-limited') return 'rate-limited';
  return 'network';
}
