import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive, ArrowRight, AtSign, Bell, ChevronDown, Clipboard, Download, Eye, FileDiff, FileSearch, FileUp, FolderKanban, FolderOpen, GitBranch, GitPullRequest,
  Keyboard, Layers3, ListChecks, MessageSquare, MessageSquareHeart, MessageSquarePlus, MessageSquareQuote, Moon, Navigation, PencilLine, Play, PlusCircle, Search,
  Info, Settings, ShieldCheck, StickyNote, TerminalSquare, Text, Type, Zap,
} from 'lucide-react';
import { Button } from '@/ui';
import { CreditLine } from '@/ui/CreditLine';
import { useTranslation } from '@/i18n/useTranslation';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { createChatOrConfigure, useNewChatPending } from '@/app/newChat';
import { createTerminalOrPick } from '@/app/newTerminal';
import { BackButton } from '@/app/BackButton';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import './helpScreen.css';
import { MachineWorkflowGuide, AgentSkillsGuide } from '@/screens/onboarding/CapabilityGuide';
import { TeamGettingStarted } from '@/screens/onboarding/TeamGettingStarted';
import { AutomationsGettingStarted } from '@/screens/onboarding/AutomationsGettingStarted';

const GROUPS = [
  { key: 'navigate', icon: Keyboard, capabilities: [
    { key: 'shortcuts', icon: Keyboard, badge: '⌘ / Ctrl K' }, { key: 'sessionSearch', icon: Search, badge: '⌘ / Ctrl ⇧ F' },
    { key: 'quickOpen', icon: FileSearch, badge: '⌘ / Ctrl P' },
    { key: 'settingsSearch', icon: Search }, { key: 'peek', icon: Eye }, { key: 'files', icon: FolderOpen },
  ] },
  // B-593: the Orca-round features (B-563~B-588), described where people look for "how do I…"
  { key: 'review', icon: FileDiff, capabilities: [
    { key: 'turnDiff', icon: FileDiff }, { key: 'reviewAll', icon: ListChecks }, { key: 'diffComments', icon: MessageSquare }, { key: 'gitActions', icon: GitPullRequest },
  ] },
  { key: 'converse', icon: MessageSquareQuote, capabilities: [
    { key: 'approvals', icon: ShieldCheck }, { key: 'quote', icon: MessageSquareQuote }, { key: 'continue', icon: Play },
    { key: 'drafts', icon: PencilLine }, { key: 'fileMention', icon: AtSign },
    { key: 'promptRail', icon: Navigation }, { key: 'fontSize', icon: Type },
  ] },
  { key: 'sessions', icon: GitBranch, capabilities: [
    { key: 'worktree', icon: GitBranch }, { key: 'hibernate', icon: Moon }, { key: 'archive', icon: Archive, badge: '⌘ / Ctrl W' }, { key: 'notify', icon: Bell },
  ] },
  { key: 'organize', icon: Layers3, capabilities: [{ key: 'projects', icon: FolderKanban }, { key: 'notes', icon: StickyNote, badge: '⌘ / Ctrl J' }, { key: 'todos', icon: ListChecks }, { key: 'automations', icon: Zap }] },
  { key: 'handoff', icon: Clipboard, capabilities: [
    { key: 'views', icon: Text }, { key: 'fileHandoff', icon: FileUp }, { key: 'termPaths', icon: TerminalSquare },
    { key: 'download', icon: Download }, { key: 'clipboard', icon: Clipboard },
  ] },
] as const;

export function HelpScreen() {
  const navigate = useNavigate();
  const creatingChat = useNewChatPending();
  const { t, lang } = useTranslation();
  const [showNewChat, setShowNewChat] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  return (
    <main className="help-screen">
      <div className="help-screen__inner">
        {/* B-728 (P2-17 / UI-P1-11): the back arrow carries its page name, like the other workspace pages */}
        <div className="help-screen__back"><BackButton /><span className="help-screen__back-title">{t('sidebar.help')}</span></div>
        <section className="help-screen__hero" aria-labelledby="help-screen-title">
          <div className="eyebrow">{t('workspaceGuide.eyebrow')}</div>
          <h1 id="help-screen-title">{t('workspaceGuide.title')}</h1>
          <p>{t('workspaceGuide.compactIntro')}</p>
          <div className="help-screen__actions" aria-label={t('workspaceGuide.stepsLabel')}>
            <Button variant="primary" onClick={() => navigate('/machine/connect')} leftIcon={<PlusCircle size={16} />}>{t('connectMachine.title')}</Button>
            <Button variant="secondary" loading={creatingChat} onPointerDown={prefetchSessionDetail} onClick={() => void createChatOrConfigure(navigate, () => setShowNewChat(true))} leftIcon={<MessageSquarePlus size={16} />}>{t('workspaceGuide.createChat')}</Button>
            <Button variant="secondary" onClick={() => createTerminalOrPick(navigate)} leftIcon={<TerminalSquare size={16} />}>{t('workspaceGuide.createTerminal')}</Button>
            {/* B-836: the feedback form, one tap from 帮助 on every layout */}
            <Button variant="ghost" data-action="feedback" onClick={() => navigate('/settings/feedback')} leftIcon={<MessageSquareHeart size={16} />}>{t('feedback.title')}</Button>
          </div>
        </section>

        <MachineWorkflowGuide />
        <TeamGettingStarted />
        <AutomationsGettingStarted />
        <AgentSkillsGuide />

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
          <button type="button" onClick={() => navigate('/machine/connect')}><PlusCircle size={14} />{t('connectMachine.title')}</button>
          <button type="button" onClick={() => navigate('/settings')}><Settings size={14} />{t('workspaceGuide.openSettings')}</button>
          <button type="button" onClick={() => navigate('/changelog')}>{t('settings.whatsNew')} <ArrowRight size={13} /></button>
          <button type="button" onClick={() => navigate('/settings/machines')}>{lang.startsWith('zh') ? '机器与 CLI 更新' : 'Machines and CLI updates'} <ArrowRight size={13} /></button>
          <button type="button" onClick={() => navigate('/docs/quickstart')}>{t('workspaceGuide.quickStart')} <ArrowRight size={13} /></button>
          <button type="button" onClick={() => navigate('/docs/keyboard')}>{t('workspaceGuide.keyboardGuide')} <ArrowRight size={13} /></button>
          <button type="button" onClick={() => navigate('/settings/about')}><Info size={14} />{t('settings.about')}</button>
        </nav>
        <CreditLine where="help" className="help-screen__credit" builtBy={t('credit.builtBy')} sourceLabel={t('credit.sourceOnGitHub')} />
      </div>
      {showNewChat && <NewSessionModal onClose={() => setShowNewChat(false)} />}
    </main>
  );
}
