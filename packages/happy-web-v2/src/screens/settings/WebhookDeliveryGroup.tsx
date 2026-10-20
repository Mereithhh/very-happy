/**
 * B-026: account webhook delivery on the diagnostics page — how many
 * notifications this server delivered, retried and gave up on, and the last
 * error. Hidden when no webhook is configured or the server predates the
 * counters.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { ItemGroup, Item, Badge } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { fetchWebhookStatus, type WebhookDelivery } from '@/sync/apiWebhook';
import { webhookHealth } from './webhookDeliveryStatus';

const TONE = { failing: 'err', recovered: 'warn', ok: 'live', idle: 'muted' } as const;

export function WebhookDeliveryGroup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { credentials } = useAuth();
  const [delivery, setDelivery] = useState<WebhookDelivery | null>(null);

  useEffect(() => {
    if (!credentials) return;
    let cancelled = false;
    fetchWebhookStatus(credentials)
      .then((status) => { if (!cancelled) setDelivery(status.webhook ? status.delivery : null); })
      .catch(() => { /* diagnostics stay usable without this group */ });
    return () => { cancelled = true; };
  }, [credentials]);

  if (!delivery) return null;
  const health = webhookHealth(delivery);
  return (
    <ItemGroup
      settingId="diagnostics.webhook"
      title={t('diagnostics.webhookDelivery')}
      footer={t('diagnostics.webhookFooter', { since: new Date(delivery.since).toLocaleString() })}
    >
      <Item
        title={t('diagnostics.webhookStatus')}
        subtitle={health === 'failing' || health === 'recovered'
          ? `${t('diagnostics.webhookLastFailure')}: ${new Date(delivery.lastFailureAt!).toLocaleString()}${delivery.lastError ? ` · ${delivery.lastError}` : ''}`
          : undefined}
        right={<Badge tone={TONE[health]}>{{
          failing: t('diagnostics.webhookHealthFailing'),
          recovered: t('diagnostics.webhookHealthRecovered'),
          ok: t('diagnostics.webhookHealthOk'),
          idle: t('diagnostics.webhookHealthIdle'),
        }[health]}</Badge>}
      />
      <Item title={t('diagnostics.webhookDelivered')} right={<span className="set-value mono">{delivery.delivered}</span>} />
      <Item title={t('diagnostics.webhookRetries')} right={<span className="set-value mono">{delivery.retries}</span>} />
      <Item title={t('diagnostics.webhookFailed')} right={<span className="set-value mono">{delivery.failed}</span>} />
      <Item title={t('diagnostics.webhookSettings')} right={<ChevronRight size={16} />} onClick={() => navigate('/settings/channels')} />
    </ItemGroup>
  );
}
