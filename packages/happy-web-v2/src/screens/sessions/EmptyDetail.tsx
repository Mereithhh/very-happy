import { EmptyState, Button } from '@/ui';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';

export function EmptyDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <EmptyState
        title={t('emptyState.pickUpTitle' as any)}
        description={t('emptyState.pickUpDescription' as any)}
        actions={
          <Button variant="primary" onClick={() => navigate('/terminal')}>
            {t('emptyState.newSession' as any)}
          </Button>
        }
      />
    </div>
  );
}
