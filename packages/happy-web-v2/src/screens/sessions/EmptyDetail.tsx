import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquarePlus, TerminalSquare } from 'lucide-react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { createChatOrConfigure } from '@/app/newChat';
import { createTerminalOrPick } from '@/app/newTerminal';
import { NewSessionModal } from './NewSessionModal';
import './emptyDetail.css';

export function EmptyDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [showNewChat, setShowNewChat] = useState(false);
  return (
    <main className="empty-detail">
      <div className="empty-detail__content">
        <h1>{t('emptyState.pickUpTitle')}</h1>
        <p>{t('emptyState.pickUpDescription')}</p>
        <div className="empty-detail__actions">
          <Button variant="primary" leftIcon={<MessageSquarePlus size={16} />} onClick={() => void createChatOrConfigure(navigate, () => setShowNewChat(true))}>{t('emptyState.newSession')}</Button>
          <Button variant="secondary" leftIcon={<TerminalSquare size={16} />} onClick={() => createTerminalOrPick(navigate)}>{t('emptyState.openWebTerminal')}</Button>
        </div>
      </div>
      {showNewChat && <NewSessionModal onClose={() => setShowNewChat(false)} />}
    </main>
  );
}
