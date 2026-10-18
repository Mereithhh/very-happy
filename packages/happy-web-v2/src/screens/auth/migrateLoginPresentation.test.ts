import { describe, expect, it } from 'vitest';
import { migrateLoginMode, parseMigrationHandoff } from './migrateLoginPresentation';

describe('B-627 /login/migrate presentation', () => {
  const ticket = `vh1.${'a'.repeat(40)}.${'b'.repeat(43)}`;
  it('accepts only a well-formed ticket', () => {
    expect(parseMigrationHandoff(`?handoff=${ticket}`)).toBe(ticket);
    expect(parseMigrationHandoff('?handoff=vh1.short.sig')).toBeNull();
    expect(parseMigrationHandoff('?handoff=<script>')).toBeNull();
    expect(parseMigrationHandoff('')).toBeNull();
  });
  it('rides the SSO round trip when the relay has an issuer, otherwise spends the ticket directly', () => {
    expect(migrateLoginMode(null, { oidc: { displayName: 'SSO' } })).toBe('invalid');
    expect(migrateLoginMode(ticket, 'loading')).toBe('loading');
    expect(migrateLoginMode(ticket, { oidc: { displayName: 'SSO' } })).toBe('sso');
    expect(migrateLoginMode(ticket, {})).toBe('direct');
    expect(migrateLoginMode(ticket, null)).toBe('direct');
  });
});
