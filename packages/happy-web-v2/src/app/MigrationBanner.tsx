import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Truck, X } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { loadMigrationTarget, requestMigrationHandoff, type MigrationTarget } from '@/auth/cloudAuth';
import { useLocalSettingMutable } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { BRAND } from './brand';
import { migrationBannerHintId, migrationBannerVisible } from './migrationBannerPolicy';
import './migrationBanner.css';

/**
 * B-627: "this relay moved" — shown on the OLD relay to accounts it targets.
 * One click mints a signed ticket and sends the browser to the new relay's
 * `/login/migrate`, where SSO (or a direct login) claims the same account.
 * Dismissal is per device and wears off (migrationBannerPolicy.ts).
 */
export function MigrationBanner() {
  const { credentials } = useAuth();
  const { t } = useTranslation();
  const [target, setTarget] = useState<MigrationTarget | null>(null);
  const [dismissedHints, setDismissedHints] = useLocalSettingMutable('dismissedHints');
  const [state, setState] = useState<'idle' | 'moving' | 'failed'>('idle');

  useEffect(() => {
    if (!credentials) return;
    let cancelled = false;
    void loadMigrationTarget(credentials).then((loaded) => { if (!cancelled) setTarget(loaded); });
    return () => { cancelled = true; };
  }, [credentials]);

  const visible = useMemo(() => target !== null && migrationBannerVisible(dismissedHints[migrationBannerHintId(target.url)], Date.now()), [target, dismissedHints]);
  if (!target || !visible || !credentials) return null;

  const move = async () => {
    if (state === 'moving') return;
    setState('moving');
    try {
      window.location.assign(await requestMigrationHandoff(credentials));
    } catch {
      setState('failed');
    }
  };
  const dismiss = () => setDismissedHints({ ...dismissedHints, [migrationBannerHintId(target.url)]: Date.now() });

  return (
    <aside className="relay-move" role="region" aria-live="polite" aria-labelledby="relay-move-title">
      <button className="relay-move__close" type="button" onClick={dismiss} aria-label={t('migration.later')}>
        <X size={17} />
      </button>
      <Truck className="relay-move__icon" size={22} aria-hidden="true" />
      <div className="relay-move__body">
        <div className="relay-move__eyebrow mono">{t('migration.eyebrow')}</div>
        <strong id="relay-move-title">{t('migration.title', { brand: BRAND.name, target: target.name })}</strong>
        <p>{t('migration.body', { target: target.name })}</p>
        {state === 'failed' && <div className="auth-error" role="alert">{t('migration.failed')}</div>}
        <div className="relay-move__actions">
          <button type="button" onClick={() => void move()} disabled={state === 'moving'}>
            {state === 'moving' ? t('migration.moving') : t('migration.move', { target: target.name })}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
          <button type="button" onClick={dismiss}>{t('migration.later')}</button>
        </div>
      </div>
    </aside>
  );
}
