// @vitest-environment happy-dom
/**
 * B-859d: signup succeeds, then login() hits the crypto-module ready timeout. The account
 * exists and its credentials are stored, so the page must say the crypto module is not
 * loaded and offer a reload — not a generic signup failure.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadyTimeoutError } from '@/encryption/readyDeadline';
import { SyncNotStartedError } from '@/sync/syncNotStarted';
import { ToastProvider } from '@/ui';

const login = vi.fn<(token: string, secret: string) => Promise<void>>();
const navigate = vi.fn();
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ login }) }));
vi.mock('@/auth/passwordUnlock', async (orig) => ({
  ...(await orig<typeof import('@/auth/passwordUnlock')>()),
  signupWithPassword: vi.fn(async () => ({ token: 't', secret: 's' })),
}));
vi.mock('@/auth/cloudAuth', async (orig) => ({
  ...(await orig<typeof import('@/auth/cloudAuth')>()),
  loadPublicAuthConfig: vi.fn(async () => ({
    emailOtpEnabled: false,
    passwordLoginEnabled: true,
    signup: { mode: 'open', maxAccounts: null, registeredAccounts: 0, remainingAccounts: null, atCapacity: false },
  })),
}));
vi.mock('./GoogleLoginButton', () => ({ GoogleLoginButton: () => null }));
vi.mock('@/screens/common/CyberBackdrop', () => ({ CyberBackdrop: () => null }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  login.mockReset();
  navigate.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function signUp() {
  const { SignupScreen } = await import('./SignupScreen');
  await act(async () => { root.render(<ToastProvider><MemoryRouter><SignupScreen /></MemoryRouter></ToastProvider>); await flush(); });
  const form = host.querySelector<HTMLFormElement>('form.auth-password-form')!;
  expect(form).not.toBeNull();
  await act(async () => {
    setValue(form.querySelector('input[autocomplete="username"]')!, 'b859d');
    const [pw, confirm] = form.querySelectorAll<HTMLInputElement>('input[type="password"]');
    setValue(pw, 'password-b859d');
    setValue(confirm, 'password-b859d');
  });
  await act(async () => { form.requestSubmit(); await flush(); });
}

describe('B-859d signup → login() crypto ready timeout', () => {
  it('shows the crypto-not-loaded notice with a reload button instead of the generic signup error', async () => {
    login.mockRejectedValue(new SyncNotStartedError(new ReadyTimeoutError('libsodium', 12_000)));
    await signUp();
    expect(login).toHaveBeenCalledWith('t', 's');
    const notice = host.querySelector('.auth-crypto-not-ready');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('The encryption module has not finished loading');
    // B-859e: the notice sits at the top of the card; it must take focus so it is not missed.
    expect(document.activeElement).toBe(notice);
    expect(host.querySelector('.auth-password-form .auth-error')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    const reload = vi.fn();
    const realLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
    try {
      act(() => notice!.querySelector('button')!.click());
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    }
  });

  it('keeps the generic signup error for any other login failure', async () => {
    login.mockRejectedValue(new SyncNotStartedError(new Error('bad key')));
    await signUp();
    expect(host.querySelector('.auth-crypto-not-ready')).toBeNull();
    expect(host.querySelector('.auth-password-form .auth-error')?.textContent).toBeTruthy();
  });
});
