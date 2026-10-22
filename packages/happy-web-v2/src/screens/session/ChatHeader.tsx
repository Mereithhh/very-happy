import { ClaudeRuntimeDialog } from './ClaudeRuntimeDialog';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { useLocalSetting } from '@/sync/storage';
import { useNavigate } from 'react-router-dom';
import { Bot, Moon } from 'lucide-react';
import { useProjects } from '@/sync/projects';
import { buildSessionMenu, sessionMenuAvailability } from '@/app/sessionMenu';
import { copySessionLink, leaveSessionProject, stopSessionTurn } from '@/app/sessionMenuActions';
import { confirmArchiveSession, nextSessionPathAfterClose, collectAllTags, saveRowRename } from '@/app/rowActions';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { priorityLevel, setPriorityLevel } from '@/utils/tags';
import { sessionUpdateTitleTags } from '@/sync/ops';
import { RenameModal } from '@/screens/sessions/RenameModal';
import { MoveToProjectModal } from '@/screens/projects/MoveToProjectModal';
import { sessionProjectMenu } from '@/screens/projects/projectChoice';
import { ShareDialog } from './ShareDialog';
import { isSharedWithMe } from '@/app/sessionAccess';
import { isMirrorSession } from '@/assistant/assistantSession';
import * as Popover from '@radix-ui/react-popover';
/**
 * ChatHeader — title (editable rename), machine·cwd breadcrumb, relay badge,
 * and the global back button.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StickyNote, Check, FolderOpen, MessageCircleQuestion, MoreHorizontal, Pencil, X } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useSession, useSessions } from '@/sync/storage';
import { sessionSetKeepAwake, sessionUpdateTitle } from '@/sync/ops';
import { supportsKeepAwake } from '@/app/sessionHibernation';
import { toast } from '@/ui/Toast';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu, Spinner, type MenuItemDef } from '@/ui';
import { useIsTablet } from '@/app/useMediaQuery';
import { planChatHeaderActions, type ChatHeaderActionKey } from './chatHeaderLayout';
import { useImeGuard } from '@/utils/ime';
import { apiSocket, type MachineRelayStatus } from '@/sync/apiSocket';
import { RelayBadge } from '@/components/RelayBadge';
import { sessionAgentLabel } from './sessionAgentLabel';
import { PrStatusChip } from './git/PrStatusChip';
import { useFeatureTipAnchor } from '@/components/featureTips/FeatureTips';
import { LocationTrail } from '@/components/LocationTrail';
import { sessionTrail, trailCopy, visibleTrail } from '@/app/locationTrail';
import './header.css';

export function ChatHeader({
    sessionId,
    filesOpen,
    onToggleFiles,
    btwOpen,
    onToggleBtw,
    boardAction,
}: {
    sessionId: string;
    filesOpen?: boolean;
    onToggleFiles?: () => void;
    /** B-283 `/btw` side-question panel; absent = this session can't host it */
    btwOpen?: boolean;
    onToggleBtw?: () => void;
    /** B-766: the 汇报板 button (owned by the board; absent when the session has none). */
    boardAction?: ReactNode;
}) {
    const { t, lang } = useTranslation();
    // B-588: the ⌘P tip sits next to the files button — the visible neighbour
    // of a keyboard-only entry, so only offered to fine (keyboard) pointers.
    const filesBtnRef = useRef<HTMLButtonElement | null>(null);
    const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true;
    useFeatureTipAnchor('quick-open', filesBtnRef, finePointer && !!onToggleFiles, { dismissOnClick: false });
    const navigateTeam = useNavigate();
    const showTeams = useLocalSetting('happyBotEntryVisible');
    const teams = useTeamNavigation();
    const session = useSession(sessionId);
    const [editing, setEditing] = useState(false);
    const [runtimeOpen, setRuntimeOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [moveProjectOpen, setMoveProjectOpen] = useState(false);
    const [tagsOpen, setTagsOpen] = useState(false);
    const projectsSnap = useProjects();
    // B-619: shared WITH me → every owner-only control disappears (the server refuses them anyway).
    const sharedWithMe = !!session && isSharedWithMe(session);
    // B-756: same liveness entry point as the composer's Stop (铁律 13) and the same gate as the sidebar row menu.
    const leaseFresh = useHeartbeatFresh(sessionId);
    const running = !!session && isAgentWorkLive({ presence: session.presence, thinking: session.thinking, runningSubagentsInTurn: 0, heartbeatFresh: leaseFresh });
    const avail = session ? sessionMenuAvailability({ archivedAt: session.archivedAt, share: sharedWithMe ? true : undefined }, { running, mirror: isMirrorSession(session) }) : null;
    const canShare = !!avail?.share;
    const canControlRuntime = !sharedWithMe && session?.metadata?.capabilities?.includes('claude-runtime-controls-v1') === true;
    // B-587: only a wrapper that can hibernate offers「保持唤醒」(AGENTS #14).
    const canKeepAwake = !sharedWithMe && supportsKeepAwake(session?.metadata);
    const keepAwake = session?.metadata?.keepAwake === true;
    const toggleKeepAwake = () => {
        const next = !keepAwake;
        sessionSetKeepAwake(sessionId, next)
            .then(() => toast.success(next ? t('hibernation.keepAwakeOn') : t('hibernation.keepAwakeOff')))
            .catch(() => toast.error(t('hibernation.keepAwakeFailed')));
    };
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const ime = useImeGuard();
    const isTablet = useIsTablet();

    const meta = session?.metadata;
    const title = meta?.summary?.text?.trim() || t('session.newChat');
    const agent = sessionAgentLabel(meta?.flavor, t('status.unknown'));
    const host = meta?.host;
    const cwd = meta?.path;
    const machineId = meta?.machineId;
    const [relayStatus, setRelayStatus] = useState<MachineRelayStatus>(() =>
        machineId ? apiSocket.getMachineRelayStatus(machineId) : { transport: 'legacy', state: 'fallback' });
    useEffect(() => {
        if (!machineId) return;
        setRelayStatus(apiSocket.getMachineRelayStatus(machineId));
        return apiSocket.onMachineRelayStatus((changedMachineId, next) => {
            if (changedMachineId === machineId) setRelayStatus(next);
        });
    }, [machineId]);

    const startEdit = () => {
        if (sharedWithMe) return; // B-619: the title is the owner's metadata
        setDraft(meta?.summary?.text ?? '');
        setEditing(true);
    };

    const save = async () => {
        setSaving(true);
        try {
            await sessionUpdateTitle(sessionId, draft);
            setEditing(false);
        } catch {
            /* keep editing on failure */
        } finally {
            setSaving(false);
        }
    };

    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // IME guard: committing a CJK composition must not save/close the editor.
        if (ime.isGuarded(e)) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            void save();
        } else if (e.key === 'Escape') {
            setEditing(false);
        }
    };

    // Header composition — see chatHeaderLayout.ts. On mobile this header is a
    // session's only chrome, and three rigid icon buttons next to the relay pill
    // left the title 8-12 characters at 360-390px.
    const plan = planChatHeaderActions({
        compact: !isTablet,
        hasBtw: !!onToggleBtw,
        hasFiles: !!onToggleFiles,
    });
    // B-726: the session header can move this session into / out of a project (also from the sidebar row and the new-session dialog).
    // B-763: 项目 › 团队 › 当前 — the same placement as the sidebar tree; phones keep only the parent.
    const trail = useMemo(() => sessionTrail(sessionId, projectsSnap, teams), [sessionId, projectsSnap, teams]);
    const projectMenu = sessionProjectMenu(sessionId, projectsSnap, { shared: sharedWithMe, zh: lang.startsWith('zh') });
    const zh = lang.startsWith('zh');
    const leave = projectMenu.leave;
    // B-756: the session's shared actions — the same builder and gate as the sidebar row's ⋯ / right-click menu.
    const sessionItems: MenuItemDef[] = session && avail ? buildSessionMenu({
        t,
        zh,
        onShare: avail.share ? () => setShareOpen(true) : undefined,
        onRename: avail.rename ? startEdit : undefined,
        onTags: avail.tags ? () => setTagsOpen(true) : undefined,
        project: projectMenu,
        onMoveToProject: () => setMoveProjectOpen(true),
        onLeaveProject: leave ? () => void leaveSessionProject(leave.projectId, sessionId, zh) : undefined,
        priority: avail.priority ? {
            level: priorityLevel(meta?.tags),
            onSet: (level) => { void sessionUpdateTitleTags(sessionId, { tags: setPriorityLevel(meta?.tags, level) }).catch(() => {}); },
        } : undefined,
        onCopyLink: () => void copySessionLink(`/session/${encodeURIComponent(sessionId)}`, zh),
        onStop: avail.stop ? () => void stopSessionTurn(sessionId, t('session.chat.stopFailed')) : undefined,
        onArchive: avail.archive ? () => {
            void confirmArchiveSession(session).then((archived) => { if (archived) navigateTeam(nextSessionPathAfterClose(sessionId)); });
        } : undefined,
    }) : [];
    const canStartTeam = !sharedWithMe && showTeams && session?.metadata?.capabilities?.includes('teams-adopt-v1') && session.archivedAt == null && !teams.some(t => t.bots.some(b => b.sessionId === sessionId));
    const titleButton = (
        <button type="button" className="ch-title-btn" onClick={startEdit} disabled={sharedWithMe} title={sharedWithMe ? undefined : t('session.renameTitle')}>
            <span className="ch-title">{trail.member && <span className="ch-member">{trail.member.lead ? (zh ? '负责人' : 'Lead') : trail.member.name} · </span>}{title}</span>
            <Pencil size={13} className="ch-title-pencil" />
        </button>
    );
    const overflowHasActive = plan.overflow.some(
        (key) => (key === 'btw' && btwOpen) || (key === 'files' && filesOpen),
    );
    const menuItem = (key: ChatHeaderActionKey): MenuItemDef => {
        switch (key) {
            case 'notes':
                return { key, label: t('notes.title'), icon: StickyNote, onSelect: toggleNotesPanel };
            // `checked` ⇒ menuitemcheckbox, so these keep the aria-pressed state
            // they had as header buttons before B-293 collapsed them.
            case 'btw':
                return { key, label: t('session.btw.title'), icon: MessageCircleQuestion, checked: !!btwOpen, onSelect: () => onToggleBtw?.() };
            case 'files':
                return { key, label: t('session.chat.files'), icon: FolderOpen, checked: !!filesOpen, onSelect: () => onToggleFiles?.() };
        }
    };
    const renderAction = (key: ChatHeaderActionKey) => {
        switch (key) {
            case 'notes':
                // B-115: quick notes entry.
                return (
                    <button
                        key={key}
                        type="button"
                        className="ch-icon"
                        onClick={toggleNotesPanel}
                        aria-label={t('notes.title')}
                        title={t('notes.title')}
                    >
                        <StickyNote size={16} />
                    </button>
                );
            case 'btw':
                return (
                    <button
                        key={key}
                        type="button"
                        className={`ch-icon ch-btw-toggle${btwOpen ? ' is-active' : ''}`}
                        onClick={onToggleBtw}
                        aria-label={t('session.btw.title')}
                        title={t('session.btw.headerHint')}
                        aria-pressed={btwOpen}
                    >
                        <MessageCircleQuestion size={16} />
                    </button>
                );
            case 'files':
                return (
                    <button
                        key={key}
                        type="button"
                        ref={filesBtnRef}
                        className={`ch-icon ch-files-toggle${filesOpen ? ' is-active' : ''}`}
                        onClick={onToggleFiles}
                        aria-label={t('session.chat.files')}
                        title={t('session.chat.files')}
                        aria-pressed={filesOpen}
                    >
                        <FolderOpen size={16} />
                    </button>
                );
        }
    };

    return (
        <header className="ch">
            <BackButton />
            <div className="ch-main">
                {editing ? (
                    <div className="ch-rename">
                        <input
                            className="ch-rename-input"
                            value={draft}
                            autoFocus
                            placeholder={t('session.renamePlaceholder')}
                            onChange={(e) => setDraft(e.target.value)}
                            onCompositionStart={ime.onCompositionStart}
                            onCompositionEnd={ime.onCompositionEnd}
                            onKeyDown={onKey}
                            disabled={saving}
                        />
                        <button type="button" className="ch-icon" onClick={() => void save()} disabled={saving} aria-busy={saving} aria-label={t('common.save')}>
                            {saving ? <Spinner size={14} /> : <Check size={16} />}
                        </button>
                        <button type="button" className="ch-icon" onClick={() => setEditing(false)} disabled={saving} aria-label={t('common.cancel')}>
                            <X size={16} />
                        </button>
                    </div>
                ) : trail.ancestors.length > 0 ? (
                    <LocationTrail segments={visibleTrail(trail.ancestors, !isTablet)} label={trailCopy(zh).label} className="ch-trail">{titleButton}</LocationTrail>
                ) : titleButton}

            </div>
            {!editing && <div className="ch-identity"><Popover.Root>
                <Popover.Trigger asChild><button type="button" className="ch-identity-trigger" title={[agent, host, cwd].filter(Boolean).join(' · ')}>
                    <span className="ch-agent">{agent}</span>
                    {host && <span className="ch-host">{host}</span>}
                </button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="ch-identity-details" align="end" sideOffset={6} collisionPadding={12}>
                    <dl><dt>{t('session.infoAgent')}</dt><dd>{agent}</dd><dt>{t('session.infoHost')}</dt><dd>{host || t('status.unknown')}</dd><dt>{t('session.infoPath')}</dt><dd>{cwd || t('status.unknown')}</dd></dl>
                </Popover.Content></Popover.Portal>
            </Popover.Root></div>}
            {/* Rename takes the whole bar: with the status pill and icons in
                place the input measured 4px wide at 360px — unusable. */}
            {!editing && (
                <div className="ch-status">
                    <PrStatusChip sessionId={sessionId} compact={!isTablet} />
                    <RelayBadge status={relayStatus} />
                </div>
            )}
            {!editing && plan.inline.map(renderAction)}
            {!editing && boardAction}
            {!editing && (plan.overflow.length > 0 || canStartTeam || canControlRuntime || canKeepAwake || sessionItems.length > 0) && (
                <ActionDropdownMenu items={[...plan.overflow.map(menuItem), ...sessionItems.map((item, i) => (i === 0 && plan.overflow.length > 0 ? { ...item, separatorBefore: true } : item)), ...(canControlRuntime ? [{key:'runtime-controls',label:t('runtimeControls.title'),icon:Bot,onSelect:()=>setRuntimeOpen(true)}] : []), ...(canStartTeam ? [{key:'team-adopt',label:lang.startsWith('zh') ? '用这个对话组建团队' : 'Start a team from this conversation',icon:Bot,onSelect:()=>navigateTeam(`/teams?fromSession=${encodeURIComponent(sessionId)}`)}] : []), ...(canKeepAwake ? [{key:'keep-awake',label:t('hibernation.keepAwake'),icon:Moon,checked:keepAwake,onSelect:toggleKeepAwake}] : [])]}>
                    <button
                        type="button"
                        className={`ch-icon${overflowHasActive ? ' is-active' : ''}`}
                        aria-label={t('session.chat.moreActions')}
                        title={t('session.chat.moreActions')}
                    >
                        <MoreHorizontal size={16} />
                    </button>
                </ActionDropdownMenu>
            )}
            {canControlRuntime && <ClaudeRuntimeDialog key={sessionId} sessionId={sessionId} open={runtimeOpen} onOpenChange={setRuntimeOpen}/>}
            {canShare && <ShareDialog key={`share:${sessionId}`} sessionId={sessionId} open={shareOpen} onOpenChange={setShareOpen} />}
            {moveProjectOpen && <MoveToProjectModal initialSessionId={sessionId} candidates={[]} onClose={() => setMoveProjectOpen(false)} />}
            {tagsOpen && session && <HeaderTagsModal session={session} title={meta?.summary?.text ?? ''} onClose={() => setTagsOpen(false)} />}
        </header>
    );
}

/** B-756: 「标签…」 from the header ⋯ — the sidebar's rename dialog, focused on tags. */
function HeaderTagsModal({ session, title, onClose }: { session: NonNullable<ReturnType<typeof useSession>>; title: string; onClose: () => void }) {
    const sessions = useSessions();
    const terminals = useTerminalSessions((s) => s.terminals);
    const suggestions = useMemo(() => collectAllTags(sessions, terminals), [sessions, terminals]);
    return (
        <RenameModal
            defaultTitle={title}
            tags={session.metadata?.tags ?? []}
            suggestions={suggestions}
            focusTags
            onClose={onClose}
            onSave={(nextTitle, tags) => saveRowRename({ kind: 'session', session, currentTitle: title }, nextTitle, tags)}
        />
    );
}
