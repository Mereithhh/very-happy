import { useEffect, useRef, useState } from 'react';
import { createGoogleLoginChallenge, loadPublicAuthConfig } from '@/auth/cloudAuth';
import { initialGoogleButtonState, reduceGoogleButtonState } from './googleButtonState';
import './auth.css';

type GoogleIdentity = {
  initialize(options: {
    client_id: string;
    nonce: string;
    callback: (response: { credential?: string }) => void;
  }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

let googleScriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-happy-google-identity]');
    const script = existing ?? document.createElement('script');
    const onLoad = () => resolve();
    const onError = () => {
      script.remove();
      reject(new Error('Google Identity Services failed to load'));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    if (!existing) {
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.happyGoogleIdentity = 'true';
      document.head.appendChild(script);
    }
  }).catch((error) => {
    googleScriptPromise = null;
    throw error;
  });
  return googleScriptPromise!;
}

export function GoogleLoginButton({
  disabled,
  leadingDividerLabel,
  retryLabel,
  unavailableLabel,
  onCredential,
  onUnavailable,
  required = false,
  loadingLabel,
}: {
  disabled?: boolean;
  leadingDividerLabel?: string;
  retryLabel: string;
  unavailableLabel: string;
  onCredential: (credential: string, nonce: string) => void | Promise<void>;
  onUnavailable?: () => void;
  /** Settings link flows must surface missing/failed config; public auth may hide it. */
  required?: boolean;
  loadingLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const [state, setState] = useState(initialGoogleButtonState);
  const { enabled, failed, attempt } = state;
  callbackRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;
    const markUnavailable = () => {
      if (cancelled) return;
      setState((current) => reduceGoogleButtonState(current, 'unavailable'));
      onUnavailable?.();
    };
    void loadPublicAuthConfig().then(async (config) => {
      if (cancelled) return;
      if (!config?.googleClientId) {
        if (required) markUnavailable();
        return;
      }
      try {
        await loadGoogleScript();
        if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
        const renderWithFreshChallenge = async (): Promise<void> => {
          if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
          if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
          setState((current) => reduceGoogleButtonState(current, 'rendering'));
          containerRef.current.replaceChildren();
          const challenge = await createGoogleLoginChallenge();
          if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
          const identity = window.google.accounts.id;
          identity.initialize({
            client_id: config.googleClientId!,
            nonce: challenge.nonce,
            callback: (response) => {
              if (!response.credential) return;
              if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
              void Promise.resolve(callbackRef.current(response.credential, challenge.nonce))
                .finally(() => {
                  if (!cancelled) void renderWithFreshChallenge().catch(markUnavailable);
                });
            },
          });
          identity.renderButton(containerRef.current, {
            type: 'standard',
            theme: 'outline',
            size: 'large',
            width: Math.min(328, Math.max(200, containerRef.current.clientWidth || 328)),
            text: 'continue_with',
          });
          setState((current) => reduceGoogleButtonState(current, 'rendered'));
          const expiresAtMs = Date.parse(challenge.expiresAt);
          const refreshInMs = Number.isFinite(expiresAtMs)
            ? Math.max(1_000, expiresAtMs - Date.now() - 30_000)
            : 4 * 60_000;
          refreshTimer = window.setTimeout(() => {
            void renderWithFreshChallenge().catch(markUnavailable);
          }, refreshInMs);
        };
        await renderWithFreshChallenge();
      } catch {
        markUnavailable();
      }
    });
    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [attempt, onUnavailable, required]);

  const loading = required && !enabled && !failed;
  return <div className={`auth-google-block${enabled || failed || required ? ' is-ready' : ''}${failed ? ' is-failed' : ''}${loading ? ' is-loading' : ''}`}>
    {leadingDividerLabel && <div className="auth-divider"><span>{leadingDividerLabel}</span></div>}
    <div className={`auth-google${disabled ? ' is-disabled' : ''}`} ref={containerRef} />
    {loading && <div className="auth-google-loading" role="status">{loadingLabel}</div>}
    {failed && <div className="auth-google-unavailable" role="status">
      <span>{unavailableLabel}</span>
      <button type="button" disabled={disabled} onClick={() => setState((current) => reduceGoogleButtonState(current, 'retry'))}>
        {retryLabel}
      </button>
    </div>}
  </div>;
}
