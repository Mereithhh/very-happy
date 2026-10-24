import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquarePlus, PanelLeftOpen, TerminalSquare } from 'lucide-react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { createChatOrConfigure } from '@/app/newChat';
import { createTerminalOrPick } from '@/app/newTerminal';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';
import { NewSessionModal } from './NewSessionModal';
import { AsciiField } from '@/ui/asciiField/AsciiField';
import './emptyDetail.css';

/** B-798 P2-12: 「在左侧选择」 only holds while the list is on screen. In the
 *  drawer shell (unfolded Duo, iPad portrait) or with the sidebar collapsed it
 *  sits behind the rail button, so the copy says so and offers a button. */
export function emptyDetailListHidden(prefs: { drawer: boolean; collapsed: boolean }): boolean {
  return prefs.drawer || prefs.collapsed;
}

export function EmptyDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [showNewChat, setShowNewChat] = useState(false);
  const listHidden = useSidebarPrefs((s) => emptyDetailListHidden(s));
  const showList = useSidebarPrefs((s) => s.toggleCollapsed);
  return (
    <main className="empty-detail">
      {/* B-720: full-area depth field (was B-700's single tide strip). */}
      <AsciiField preset="empty" mark />
      <div className="empty-detail__content">
        <h1>{t('emptyState.pickUpTitle')}</h1>
        <p>{t(listHidden ? 'emptyState.pickUpDescriptionListHidden' : 'emptyState.pickUpDescription')}</p>
        <div className="empty-detail__actions">
          <Button variant="primary" leftIcon={<MessageSquarePlus size={16} />} onPointerDown={prefetchSessionDetail} onClick={() => void createChatOrConfigure(navigate, () => setShowNewChat(true))}>{t('emptyState.newSession')}</Button>
          {listHidden && <Button variant="secondary" leftIcon={<PanelLeftOpen size={16} />} onClick={showList}>{t('emptyState.showList')}</Button>}
          <Button variant="secondary" leftIcon={<TerminalSquare size={16} />} onClick={() => createTerminalOrPick(navigate)}>{t('emptyState.openWebTerminal')}</Button>
        </div>
      </div>
      {showNewChat && <NewSessionModal onClose={() => setShowNewChat(false)} />}
    </main>
  );
}
