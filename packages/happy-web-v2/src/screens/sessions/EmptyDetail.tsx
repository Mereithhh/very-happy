import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Bot, Clipboard, FileUp, FolderOpen, Keyboard, ListChecks,
  MessageSquarePlus, Settings, StickyNote, TerminalSquare, Text,
} from 'lucide-react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { createChatOrConfigure } from '@/app/newChat';
import { createTerminalOrPick } from '@/app/newTerminal';
import { NewSessionModal } from './NewSessionModal';
import './emptyDetail.css';

const CAPABILITIES = [
  { key: 'shortcuts', icon: Keyboard, badge: '⌘ / Ctrl K' },
  { key: 'files', icon: FolderOpen, badge: undefined },
  { key: 'notes', icon: StickyNote, badge: '⌘ / Ctrl J' },
  { key: 'todos', icon: ListChecks, badge: undefined },
  { key: 'views', icon: Text, badge: undefined },
  { key: 'fileHandoff', icon: FileUp, badge: undefined },
  { key: 'clipboard', icon: Clipboard, badge: undefined },
] as const;

export function EmptyDetail() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [showNewChat, setShowNewChat] = useState(false);
  return (
    <main className="ed-guide">
      <section className="ed-guide__hero" aria-labelledby="workspace-guide-title">
        <div className="eyebrow">{t('workspaceGuide.eyebrow')}</div>
        <h1 id="workspace-guide-title">{t('workspaceGuide.title')}</h1>
        <p>{t('workspaceGuide.intro')}</p>
      </section>

      <ol className="ed-guide__steps" aria-label={t('workspaceGuide.stepsLabel')}>
        <li>
          <span className="ed-guide__number">01</span>
          <MessageSquarePlus size={21} aria-hidden="true" />
          <div>
            <h2>{t('workspaceGuide.chatTitle')}</h2>
            <p>{t('workspaceGuide.chatDescription')}</p>
            <Button variant="primary" onClick={() => void createChatOrConfigure(navigate, () => setShowNewChat(true))} rightIcon={<ArrowRight size={14} />}>
              {t('workspaceGuide.createChat')}
            </Button>
          </div>
        </li>
        <li>
          <span className="ed-guide__number">02</span>
          <TerminalSquare size={21} aria-hidden="true" />
          <div>
            <h2>{t('workspaceGuide.terminalTitle')}</h2>
            <p>{t('workspaceGuide.terminalDescription')}</p>
            <Button variant="secondary" onClick={() => createTerminalOrPick(navigate)}>{t('workspaceGuide.createTerminal')}</Button>
          </div>
        </li>
        <li>
          <span className="ed-guide__number">03</span>
          <Settings size={21} aria-hidden="true" />
          <div>
            <h2>{t('workspaceGuide.settingsTitle')}</h2>
            <p>{t('workspaceGuide.settingsDescription')}</p>
            <Button variant="secondary" onClick={() => navigate('/settings')}>{t('workspaceGuide.openSettings')}</Button>
          </div>
        </li>
      </ol>

      <section className="ed-guide__toolkit" aria-labelledby="workspace-toolkit-title">
        <div className="ed-guide__section-head">
          <div><div className="eyebrow">{t('workspaceGuide.toolkitEyebrow')}</div><h2 id="workspace-toolkit-title">{t('workspaceGuide.toolkitTitle')}</h2></div>
          <Bot size={24} aria-hidden="true" />
        </div>
        <div className="ed-guide__capabilities">
          {CAPABILITIES.map(({ key, icon: Icon, badge }) => (
            <article key={key} className="ed-guide__capability">
              <div className="ed-guide__capability-icon"><Icon size={18} aria-hidden="true" /></div>
              <div><h3>{t(`workspaceGuide.capabilities.${key}Title`)}</h3><p>{t(`workspaceGuide.capabilities.${key}Description`)}</p></div>
              {badge && <kbd>{badge}</kbd>}
            </article>
          ))}
        </div>
      </section>

      <nav className="ed-guide__docs" aria-label={t('workspaceGuide.learnMore')}>
        <span>{t('workspaceGuide.learnMore')}</span>
        <button type="button" onClick={() => navigate('/docs/quickstart')}>{t('workspaceGuide.quickStart')} <ArrowRight size={13} /></button>
        <button type="button" onClick={() => navigate('/docs/keyboard')}>{t('workspaceGuide.keyboardGuide')} <ArrowRight size={13} /></button>
      </nav>

      {showNewChat && <NewSessionModal onClose={() => setShowNewChat(false)} />}
    </main>
  );
}
