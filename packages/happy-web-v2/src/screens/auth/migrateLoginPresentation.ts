/**
 * B-627: pure state for `/login/migrate`, the page the OLD relay's banner sends
 * people to. `?handoff=` is a signed ticket for their account on this relay.
 * With an SSO issuer the ticket rides along the OIDC round trip (one click:
 * sign in with SSO AND claim the old account); without one it is spent
 * directly for a login.
 */
const HANDOFF = /^vh1\.[A-Za-z0-9_-]{16,2048}\.[A-Za-z0-9_-]{43}$/;

export function parseMigrationHandoff(search: string): string | null {
  const handoff = new URLSearchParams(search).get('handoff');
  return handoff && HANDOFF.test(handoff) ? handoff : null;
}

export type MigrateLoginMode = 'invalid' | 'loading' | 'sso' | 'direct';

export function migrateLoginMode(handoff: string | null, config: { oidc?: { displayName: string } } | null | 'loading'): MigrateLoginMode {
  if (!handoff) return 'invalid';
  if (config === 'loading') return 'loading';
  return config?.oidc ? 'sso' : 'direct';
}
