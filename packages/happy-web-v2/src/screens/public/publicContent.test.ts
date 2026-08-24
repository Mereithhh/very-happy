import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPublicDoc, INSTALL_COMMAND, LOGIN_COMMAND, PUBLIC_DOCS } from './publicContent';

describe('public documentation registry', () => {
  it('provides every public-release topic with unique stable slugs', () => {
    expect(new Set(PUBLIC_DOCS.map((doc) => doc.slug)).size).toBe(PUBLIC_DOCS.length);
    expect(PUBLIC_DOCS.map((doc) => doc.slug)).toEqual(expect.arrayContaining([
      'quickstart', 'cli', 'cloud', 'self-hosting', 'configuration', 'architecture',
      'integrations', 'security', 'accounts-and-quotas', 'upgrades', 'troubleshooting', 'contributing',
    ]));
  });

  it('keeps onboarding commands and trust disclosure in the published content', () => {
    const text = JSON.stringify(PUBLIC_DOCS);
    expect(text).toContain(INSTALL_COMMAND);
    expect(text).toContain(LOGIN_COMMAND);
    expect(text).toContain('not end-to-end encrypted');
    expect(text).toContain('server-trusted');
  });

  it('resolves known slugs and rejects unknown routes', () => {
    expect(getPublicDoc('quickstart')?.label).toBe('Quick start');
    expect(getPublicDoc('missing')).toBeUndefined();
  });

  it('keeps public positioning honest about shipped agents and roadmap', () => {
    const landing = readFileSync(new URL('./LandingScreen.tsx', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(landing).toContain('Work anywhere.');
    expect(landing).toContain('Claude Code');
    expect(landing).toContain('Codex');
    expect(landing).toContain('ACP agents');
    expect(landing).toContain('Pi + provider gateway');
    expect(landing).toContain('THE ACTUAL WORKSPACE');
    expect(landing).toContain('Terminal + files');
    expect(landing).toContain('STRUCTURED MIRROR');
    expect(landing).toContain('Agent board');
    expect(landing).toContain('A coordinator you can talk to');
    expect(landing).toContain('Claude-powered meta-agent');
    expect(landing).toContain('You get to be Very Happy.');
    expect(landing).not.toContain('private Tanka deployment');
    expect(landing).toContain('ROADMAP');
    expect(landing).toContain('not end-to-end encrypted');
    expect(html).toContain('Work anywhere. Keep the thread.');
    expect(html).not.toContain('Claude Code, from any browser.');
  });

  it('keeps anonymous public routes outside the authenticated app bundle', () => {
    const main = readFileSync(new URL('../../main.tsx', import.meta.url), 'utf8');
    const publicRoot = readFileSync(new URL('../../app/PublicRoot.tsx', import.meta.url), 'utf8');
    const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/^import .*AppRoot/m);
    expect(main).toContain("import('./app/PublicRoot.tsx')");
    expect(main).toContain("import('./app/AppRoot.tsx')");
    expect(main).toContain('auth_credentials');
    expect(publicRoot).not.toContain('AuthProvider');
    expect(publicRoot).not.toContain('@/sync/');
    expect(vite).toContain("globPatterns: ['index.html', 'manifest.webmanifest', 'registerSW.js']");
    expect(vite).toContain("handler: 'CacheFirst'");
  });

  it('keeps the public IM adapter example fail-closed and environment-neutral', () => {
    const channels = readFileSync(new URL('../../../../../docs/channels.md', import.meta.url), 'utf8');
    const spec = readFileSync(new URL('../../../../../specs/2026-08-tanka-channel.md', import.meta.url), 'utf8');
    expect(channels).toContain('allowed_sender(msg.sender)');
    expect(channels).toContain('allowed_chat(msg.chat)');
    expect(channels).toContain('allowed_workdir(msg.chat)');
    expect(channels).toContain('routing key, not authentication');
    expect(spec).toContain('Fail closed unless both sender and chat are allowlisted');
    expect(spec).not.toMatch(/mac-office|hw-sg|apodex-bot|happy\.mereith\.com\/session/);
  });
});
