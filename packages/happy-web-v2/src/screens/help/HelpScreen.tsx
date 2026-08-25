import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, ChevronDown, Clipboard, FileUp, FolderOpen, Keyboard,
  Layers3, ListChecks, MessageSquarePlus, Settings, StickyNote, TerminalSquare, Text,
} from 'lucide-react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { createChatOrConfigure } from '@/app/newChat';
import { createTerminalOrPick } from '@/app/newTerminal';
import { BackButton } from '@/app/BackButton';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import './helpScreen.css';

const GROUPS = [
  { key: 'navigate', icon: Keyboard, capabilities: [{ key: 'shortcuts', icon: Keyboard, badge: '⌘ / Ctrl K' }, { key: 'files', icon: FolderOpen }] },
  { key: 'organize', icon: Layers3, capabilities: [{ key: 'notes', icon: StickyNote, badge: '⌘ / Ctrl J' }, { key: 'todos', icon: ListChecks }] },
  { key: 'handoff', icon: Clipboard, capabilities: [{ key: 'views', icon: Text }, { key: 'fileHandoff', icon: FileUp }, { key: 'clipboard', icon: Clipboard }] },
] as const;

export function HelpScreen() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [showNewChat, setShowNewChat] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  return (
    <main className="help-screen">
      <div className="help-screen__inner">
        <BackButton className="help-screen__back" />
        <section className="help-screen__hero" aria-labelledby="help-screen-title">
          <div className="eyebrow">{t('workspaceGuide.eyebrow')}</div>
          <h1 id="help-screen-title">{t('workspaceGuide.title')}</h1>
          <p>{t('workspaceGuide.compactIntro')}</p>
          <div className="help-screen__actions" aria-label={t('workspaceGuide.stepsLabel')}>
            <Button variant="primary" onClick={() => void createChatOrConfigure(navigate, () => setShowNewChat(true))} leftIcon={<MessageSquarePlus size={16} />}>{t('workspaceGuide.createChat')}</Button>
            <Button variant="secondary" onClick={() => createTerminalOrPick(navigate)} leftIcon={<TerminalSquare size={16} />}>{t('workspaceGuide.createTerminal')}</Button>
            <button className="help-screen__settings" type="button" onClick={() => navigate('/settings')}><Settings size={16} /> {t('workspaceGuide.openSettings')} <ArrowRight size={14} /></button>
          </div>
        </section>

        <section className="help-screen__topics" aria-labelledby="help-topics-title">
          <div className="help-screen__section-head">
            <div><div className="eyebrow">{t('workspaceGuide.toolkitEyebrow')}</div><h2 id="help-topics-title">{t('workspaceGuide.compactToolkitTitle')}</h2></div>
            <span>{t('workspaceGuide.expandHint')}</span>
          </div>
          <div className="help-screen__accordion">
            {GROUPS.map(({ key, icon: GroupIcon, capabilities }) => {
              const open = openGroup === key;
              const panelId = `help-topic-${key}`;
              return (
                <article className={`help-topic${open ? ' is-open' : ''}`} key={key}>
                  <button className="help-topic__trigger" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpenGroup(open ? null : key)}>
                    <span className="help-topic__icon"><GroupIcon size={18} /></span>
                    <span className="help-topic__copy"><strong>{t(`workspaceGuide.groups.${key}Title`)}</strong><span>{t(`workspaceGuide.groups.${key}Summary`)}</span></span>
                    <ChevronDown className="help-topic__chevron" size={18} />
                  </button>
                  {open && (
                    <div className="help-topic__panel" id={panelId}>
                      {capabilities.map(({ key: capabilityKey, icon: Icon, ...capability }) => (
                        <div className="help-topic__detail" key={capabilityKey}>
                          <Icon size={17} />
                          <div><h3>{t(`workspaceGuide.capabilities.${capabilityKey}Title`)}</h3><p>{t(`workspaceGuide.capabilities.${capabilityKey}Description`)}</p></div>
                          {'badge' in capability && capability.badge && <kbd>{capability.badge}</kbd>}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <nav className="help-screen__docs" aria-label={t('workspaceGuide.learnMore')}>
          <span>{t('workspaceGuide.learnMore')}</span>
          <button type="button" onClick={() => navigate('/docs/quickstart')}>{t('workspaceGuide.quickStart')} <ArrowRight size={13} /></button>
          <button type="button" onClick={() => navigate('/docs/keyboard')}>{t('workspaceGuide.keyboardGuide')} <ArrowRight size={13} /></button>
        </nav>
      </div>
      {showNewChat && <NewSessionModal onClose={() => setShowNewChat(false)} />}
    </main>
  );
}
