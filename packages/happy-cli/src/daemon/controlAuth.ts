import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CONTROL_TOKEN_BYTES = 32;

/**
 * Mint a process-local bearer credential for the daemon's loopback HTTP
 * control plane. The token is intentionally replaced on every daemon start.
 */
export function createDaemonControlToken(): string {
  return randomBytes(CONTROL_TOKEN_BYTES).toString('base64url');
}

/**
 * Validate the Authorization header without comparing the secret directly.
 * Hashing both values to a fixed length lets timingSafeEqual run for missing,
 * malformed, short, and long credentials alike.
 */
export function isAuthorizedDaemonControlRequest(
  authorization: string | undefined,
  controlToken: string,
): boolean {
  const prefix = 'Bearer ';
  const candidate = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : '';
  const expectedDigest = createHash('sha256').update(controlToken, 'utf8').digest();
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const configuredTokenIsUsable = Buffer.byteLength(controlToken, 'utf8') >= CONTROL_TOKEN_BYTES;
  return configuredTokenIsUsable && timingSafeEqual(expectedDigest, candidateDigest);
}
