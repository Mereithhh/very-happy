import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { getAuthLatch, subscribeAuthLatch, type AuthExpiryVerdict, type AuthLatchInfo } from '@/auth/authLatch';
import { authExpiredAction, unsentMessagesClipboardText, type UnsentMessage } from '@/auth/authExpiry';
import { confirmCurrentTokenExpired } from '@/app/authGuards';
import { persistAuthReturnTarget } from '@/app/authReturnTarget';
import { markProgrammaticReload } from '@/app/programmaticReload';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, CopyButton } from '@/ui';
import { OVERLAY_PRIORITY, useOverlayTurn } from './overlayQueue';
import './authExpiredNotice.css';

/** B-825: an unanswered confirmation is asked again this often (and on every `online`). */
const RECONFIRM_MS = 30_000;

type Phase = 'confirming' | AuthExpiryVerdict;

/**
 * B-490 / B-825 / B-824 §6.2: the server rejected this browser's token.
 * Background sync is already stopped (auth/authLatch.ts) and every unsent
 * input marked failed. Before anything is wiped the verdict is confirmed once
 * (`GET /v1/account/profile` past the latch): a second 401 = signed out —
 * with nothing waiting to be sent, `purgeLocalAccountData` runs at once (via
 * logout → login screen → back here after sign-in); otherwise the unsent
 * inputs are listed first, since the wipe deletes them. An accepted token
 * means a misfire (reload, nothing wiped); no answer means wait and ask again.
 *
 * B-830: from the moment the latch trips this is the `critical` overlay
 * (overlayQueue.ts) — the release notes, a deep-link task dialog, Modal.* and
 * the install / notification cards give way until the page reloads or the
 * person signs in again. It is a native modal <dialog> in the top layer, so a
 * layer outside the queue that the person had open (a Radix menu or dialog)
 * sits underneath, inert, instead of taking the clicks meant for this one.
 */
export function AuthExpiredNotice() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const location = useLocation();
  const [latch, setLatch] = useState<AuthLatchInfo | null>(getAuthLatch);
  const [phase, setPhase] = useState<Phase>('confirming');
  const [unsent, setUnsent] = useState<UnsentMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);
  const turn = useOverlayTurn(!!latch, OVERLAY_PRIORITY.critical);

  useEffect(() => {
    setLatch(getAuthLatch());
    return subscribeAuthLatch(setLatch);
  }, []);

  const signOut = () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setBusy(true);
    persistAuthReturnTarget(location);
    void logout();
  };

  const reload = () => {
    markProgrammaticReload();
    window.location.reload();
  };

  useEffect(() => {
    if (!latch) return;
    let cancelled = false;
    let running = false;
    const confirm = async () => {
      if (running || cancelled) return;
      running = true;
      const verdict = await confirmCurrentTokenExpired().catch((): AuthExpiryVerdict => 'unknown');
      running = false;
      if (cancelled) return;
      if (verdict === 'valid') console.warn(`[auth] latch misfire: ${latch.status} on ${latch.path || 'request'}, but the token is still accepted — nothing wiped`);
      if (verdict !== 'expired') { setPhase(verdict); return; }
      const pending = await sync.unsentOutboxMessages().catch(() => [] as UnsentMessage[]);
      if (cancelled) return;
      setUnsent(pending);
      setPhase('expired');
      if (authExpiredAction(pending) === 'sign-out-now') signOut();
    };
    void confirm();
    const retry = () => { if (!cancelled) setPhase((p) => { if (p === 'unknown') void confirm(); return p; }); };
    const timer = setInterval(retry, RECONFIRM_MS);
    window.addEventListener('online', retry);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('online', retry); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latch]);

  if (!latch || !turn) return null;

  if (phase !== 'expired') {
    const [title, body] = phase === 'valid'
      ? [t('authExpired.misfireTitle'), t('authExpired.misfireBody')]
      : phase === 'unknown'
        ? [t('authExpired.unconfirmedTitle'), t('authExpired.unconfirmedBody')]
        : [t('authExpired.checkingTitle'), t('authExpired.checkingBody')];
    return (
      <AuthDialog phase={phase}>
        <h2 id="vh-auth-expired-title" className="vh-auth-expired-title">{title}</h2>
        <p className="vh-auth-expired-body">{body}</p>
        <div className="vh-auth-expired-actions">
          <Button variant={phase === 'valid' ? 'primary' : 'ghost'} fullWidth disabled={phase === 'confirming'} onClick={reload}>
            {t('authExpired.reload')}
          </Button>
        </div>
      </AuthDialog>
    );
  }

  const hasUnsent = !!unsent && unsent.length > 0;
  const copyText = unsentMessagesClipboardText(unsent ?? []);
  return (
    <AuthDialog phase={phase}>
      <h2 id="vh-auth-expired-title" className="vh-auth-expired-title">{t('authExpired.title')}</h2>
      {hasUnsent ? (
        <>
          <p className="vh-auth-expired-body">{t('authExpired.unsentBody', { count: unsent!.length })}</p>
          <ul className="vh-auth-expired-unsent" data-testid="auth-expired-unsent">
            {unsent!.map((message) => (
              <li key={message.localId} className="vh-auth-expired-unsent-item">
                {message.text?.trim() || <span className="vh-auth-expired-unsent-empty">{t('authExpired.unsentNoText')}</span>}
              </li>
            ))}
          </ul>
          {copyText && (
            <div className="vh-auth-expired-copy">
              <CopyButton text={copyText} showLabel label={t('authExpired.copyUnsent')} />
            </div>
          )}
        </>
      ) : (
        <p className="vh-auth-expired-body">{t('authExpired.body')}</p>
      )}
      <div className="vh-auth-expired-actions">
        <Button variant="primary" fullWidth loading={busy} disabled={busy} onClick={signOut}>
          {hasUnsent ? t('authExpired.discardAndSignIn') : t('authExpired.signIn')}
        </Button>
      </div>
    </AuthDialog>
  );
}

/**
 * One native modal <dialog> for every phase (opened once, the content swaps).
 * Portalled to <body>: a Radix layer opened earlier marks the then-existing
 * <body> children (#root) aria-hidden, and its `body { pointer-events: none }`
 * is overridden in authExpiredNotice.css. Esc never dismisses it.
 */
function AuthDialog({ phase, children }: { phase: Phase; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || node.open) return;
    node.showModal();
    return () => node.close();
  }, []);
  return createPortal(
    <dialog ref={ref} className="vh-auth-expired" role="alertdialog" aria-modal="true" aria-labelledby="vh-auth-expired-title" data-phase={phase} onCancel={(e) => e.preventDefault()}>
      <div className="vh-auth-expired-card">{children}</div>
    </dialog>,
    document.body,
  );
}
