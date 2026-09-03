/**
 * B-296: the four "no online machine" dead ends (new session / new terminal /
 * attach tmux / import history) used to render one flat sentence and stop
 * there. The connect instructions existed but only inside FirstRunScreen,
 * which is unreachable once the account has ever had a machine — so a user
 * whose only machine is offline had nowhere to go. Every dead end now points
 * at the same `/machine/connect` guide.
 */
import { useNavigate } from 'react-router-dom';
import { HardDrive } from 'lucide-react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

export function NoMachinesNotice({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="ns-empty">
      <p className="ns-empty-text">{t('machine.noMachines')}</p>
      <Button
        variant="secondary"
        leftIcon={<HardDrive size={14} />}
        onClick={() => {
          onClose();
          navigate('/machine/connect');
        }}
      >
        {t('connectMachine.cta')}
      </Button>
    </div>
  );
}

/** Always-available doorway next to a machine picker that already has options. */
export function ConnectMachineLink({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="ns-connect-link"
      onClick={() => {
        onClose();
        navigate('/machine/connect');
      }}
    >
      {t('connectMachine.cta')}
    </button>
  );
}
