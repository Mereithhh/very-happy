// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/ui/QuickThemeToggle', () => ({ QuickThemeToggle: () => null }));
const { PublicHeader, hasStoredAccount } = await import('./PublicShell');

/** B-728 (UI-P1-13): with an account in this browser the public header offers the workspace, not 登录 / 开始使用. */
async function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<MemoryRouter><PublicHeader /></MemoryRouter>));
  return host;
}

describe('public header follows the stored account', () => {
  afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

  it('anonymous: sign in + get started', async () => {
    const host = await render();
    expect(host.querySelector('.pub-nav-login')).not.toBeNull();
    expect(host.querySelector('.pub-nav-cta')?.getAttribute('href')).toMatch(/login$/);
  });

  it('signed in: one CTA back into the app, no sign-in link', async () => {
    localStorage.setItem('auth_credentials', '{"token":"x"}');
    const host = await render();
    expect(host.querySelector('.pub-nav-login')).toBeNull();
    const cta = host.querySelector('.pub-nav-cta')!;
    expect(cta.getAttribute('href')).not.toMatch(/login/);
    expect(cta.textContent).toMatch(/Open|打开/);
  });

  it('storage that throws reads as signed out', () => {
    expect(hasStoredAccount({ getItem: () => { throw new Error('blocked'); } })).toBe(false);
    expect(hasStoredAccount(undefined)).toBe(false);
  });
});
