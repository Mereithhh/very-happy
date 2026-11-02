import { useEffect, useRef } from 'react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * B-859c: the crypto wasm missed its load budget; only a reload fixes that.
 * B-859e: the notice renders at the top of the card while the submit control may sit
 * below the fold (short desktop windows), so on appear it scrolls itself into view and
 * takes focus — otherwise the user sees nothing change after submitting.
 */
export function CryptoNotReadyNotice() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest' });
    el.focus({ preventScroll: true });
  }, []);
  return <div ref={ref} className="auth-error auth-crypto-not-ready" role="alert" tabIndex={-1}>
    <span>{t('login.errorCryptoNotReady')}</span>
    <Button type="button" size="sm" onClick={() => window.location.reload()}>{t('login.reloadPage')}</Button>
  </div>;
}
