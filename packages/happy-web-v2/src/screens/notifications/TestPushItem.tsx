/**
 * B-570 — settings row: "Send a test notification". Calls POST /v1/push/test
 * and shows how many devices it reached; on an old server (404) the button
 * stays disabled with an explanation.
 */
import { useState } from 'react';
import { Button, Item } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { sendTestPush, type TestPushResult } from '@/sync/apiPush';
import { describeTestPushResult, testPushUnavailable, type TestPushMessage } from './notificationOnboarding';

export function TestPushItem() {
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestPushResult | null>(null);

  const message = (m: TestPushMessage): string => {
    switch (m.key) {
      case 'notifications.testPushSent': return t(m.key, m.params);
      case 'notifications.testPushSentPartial': return t(m.key, m.params);
      default: return t(m.key);
    }
  };

  const send = async () => {
    if (!credentials || busy) return;
    setBusy(true);
    try {
      setResult(await sendTestPush(credentials, {
        title: t('notifications.testPushTitle'),
        body: t('notifications.testPushBody'),
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Item
      title={t('notifications.testPush')}
      subtitle={result ? message(describeTestPushResult(result)) : t('notifications.testPushDescription')}
      right={
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={busy || !credentials || testPushUnavailable(result)}
          onClick={() => void send()}
        >
          {t('notifications.testPushButton')}
        </Button>
      }
    />
  );
}
