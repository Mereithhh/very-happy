import { EmptyState, Button } from '@/ui';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { createTerminalOrPick } from '@/app/newTerminal';

export function EmptyDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <EmptyState
        title={t('emptyState.pickUpTitle')}
        description={t('emptyState.pickUpDescription')}
        actions={
          <Button variant="primary" onClick={() => createTerminalOrPick(navigate)}>
            {t('emptyState.newSession')}
          </Button>
        }
      />
    </div>
  );
}
