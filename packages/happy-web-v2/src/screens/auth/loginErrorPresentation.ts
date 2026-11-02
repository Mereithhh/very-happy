import { isReadyTimeout } from '@/encryption/readyDeadline';

export type PasswordLoginFailure = 'invalid-credentials' | 'rate-limited' | 'crypto-not-ready' | 'network';

export function classifyPasswordLoginFailure(error: unknown): PasswordLoginFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'invalid-credentials') return 'invalid-credentials';
  if (code === 'rate-limited') return 'rate-limited';
  // B-859c: the wasm crypto module missed its load budget; the server is fine.
  if (isReadyTimeout(error)) return 'crypto-not-ready';
  return 'network';
}
