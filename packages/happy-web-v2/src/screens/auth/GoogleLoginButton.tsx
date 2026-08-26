import { useEffect, useRef, useState } from 'react';
import { createGoogleLoginChallenge, loadPublicAuthConfig } from '@/auth/cloudAuth';
import { useTheme } from '@/ui';
import {
  initialGoogleButtonState,
  googleButtonTheme,
  reduceGoogleButtonState,
  shouldShowGoogleBlock,
  type GoogleAvailability,
} from './googleButtonState';
import { googleButtonWidth } from './googleButtonLayout';
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
  const { resolved: resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const [state, setState] = useState(initialGoogleButtonState);
  const [availability, setAvailability] = useState<GoogleAvailability>('checking');
  const { enabled, failed, attempt } = state;
  callbackRef.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;
    let resizeFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let lastRenderedWidth: number | null = null;
    const markUnavailable = () => {
      if (cancelled) return;
      setState((current) => reduceGoogleButtonState(current, 'unavailable'));
      onUnavailable?.();
    };
    void loadPublicAuthConfig().then(async (config) => {
      if (cancelled) return;
      if (!config?.googleClientId) {
        setAvailability('absent');
        if (required) markUnavailable();
        return;
      }
      setAvailability('configured');
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
          const renderAtHostWidth = () => {
            if (cancelled || !containerRef.current) return;
            const width = googleButtonWidth(containerRef.current.clientWidth);
            if (width === null || (width === lastRenderedWidth && containerRef.current.childElementCount > 0)) return;
            containerRef.current.replaceChildren();
            identity.renderButton(containerRef.current, {
              type: 'standard',
              theme: googleButtonTheme(resolvedTheme),
              size: 'large',
              width,
              text: 'continue_with',
            });
            lastRenderedWidth = width;
            setState((current) => reduceGoogleButtonState(current, 'rendered'));
          };
          resizeObserver?.disconnect();
          resizeObserver = new ResizeObserver(() => {
            if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
            resizeFrame = window.requestAnimationFrame(renderAtHostWidth);
          });
          resizeObserver.observe(containerRef.current);
          renderAtHostWidth();
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
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
    };
  }, [attempt, onUnavailable, required, resolvedTheme]);

  const visible = shouldShowGoogleBlock(availability, required, failed);
  const loading = visible && !enabled && !failed;
  return <div className={`auth-google-block${visible ? ' is-ready' : ''}${failed ? ' is-failed' : ''}${loading ? ' is-loading' : ''}`}>
    {leadingDividerLabel && <div className="auth-divider"><span>{leadingDividerLabel}</span></div>}
    <div className="auth-google-slot">
      <div className={`auth-google${disabled ? ' is-disabled' : ''}`} ref={containerRef} />
      {loading && <div className="auth-google-loading" role={loadingLabel ? 'status' : undefined} aria-hidden={loadingLabel ? undefined : true}>{loadingLabel}</div>}
    </div>
    {failed && <div className="auth-google-unavailable" role="status">
      <span>{unavailableLabel}</span>
      <button type="button" disabled={disabled} onClick={() => setState((current) => reduceGoogleButtonState(current, 'retry'))}>
        {retryLabel}
      </button>
    </div>}
  </div>;
}
