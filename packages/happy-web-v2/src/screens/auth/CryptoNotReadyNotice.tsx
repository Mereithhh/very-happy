import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

/** B-859c: the crypto wasm missed its load budget; only a reload fixes that. */
export function CryptoNotReadyNotice() {
  const { t } = useTranslation();
  return <div className="auth-error auth-crypto-not-ready" role="alert">
    <span>{t('login.errorCryptoNotReady')}</span>
    <Button type="button" size="sm" onClick={() => window.location.reload()}>{t('login.reloadPage')}</Button>
  </div>;
}
