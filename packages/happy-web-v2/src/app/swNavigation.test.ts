import { describe, expect, it } from 'vitest';
import { navigationFallbackDenylist } from './swNavigation';

const bypassesShell = (path: string, base = '/') => navigationFallbackDenylist(base).some(rule => rule.test(path));

describe('service worker document navigation', () => {
  it('serves skill documents through HTTP, including copied links with queries', () => {
    expect(bypassesShell('/skills/very-happy-todo-provider/SKILL.md')).toBe(true);
    expect(bypassesShell('/skills/very-happy-todo-provider/SKILL.md?from=todos')).toBe(true);
  });
  it('preserves SPA routes and existing API exclusions', () => {
    expect(bypassesShell('/todos')).toBe(false);
    expect(bypassesShell('/session/skills-review')).toBe(false);
    expect(bypassesShell('/v1/kv')).toBe(true);
    expect(bypassesShell('/health')).toBe(true);
  });
  it('scopes documents to the configured base and escapes regexp characters', () => {
    expect(bypassesShell('/happy.v2/skills/provider/SKILL.md', '/happy.v2/')).toBe(true);
    expect(bypassesShell('/happyXv2/skills/provider/SKILL.md', '/happy.v2/')).toBe(false);
    expect(bypassesShell('/skills/provider/SKILL.md', '/happy.v2/')).toBe(false);
  });
});
