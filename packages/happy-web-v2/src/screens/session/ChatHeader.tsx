/**
 * ChatHeader — title (editable rename), machine·cwd breadcrumb, connection dot,
 * and the global back button.
 */
import { useEffect, useState } from 'react';
import { StickyNote, Check, FolderTree, MessageCircleQuestion, MoreHorizontal, Pencil, X } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useSession } from '@/sync/storage';
import { useSocketStatus } from '@/app/useConnection';
import { sessionUpdateTitle } from '@/sync/ops';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu, Spinner, StatusDot, type MenuItemDef, type Status } from '@/ui';
import { useIsTablet } from '@/app/useMediaQuery';
import { planChatHeaderActions, type ChatHeaderActionKey } from './chatHeaderLayout';
import { useImeGuard } from '@/utils/ime';
import { apiSocket, type MachineRelayStatus } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { relayRegionLabel } from './relayLabel';
import './header.css';

// Session is "connected" when its agent is online AND our relay socket is up.
// (Previously gated on the realtime/voice status — a cut feature — so it never
// showed connected.)
function connectionStatus(presence: 'online' | number | undefined, socketStatus: string): Status {
    if (presence !== 'online') return 'offline';
    if (socketStatus === 'connected') return 'connected';
    return 'offline';
}

export function ChatHeader({
    sessionId,
    filesOpen,
    onToggleFiles,
    btwOpen,
    onToggleBtw,
}: {
    sessionId: string;
    filesOpen?: boolean;
    onToggleFiles?: () => void;
    /** B-283 `/btw` side-question panel; absent = this session can't host it */
    btwOpen?: boolean;
    onToggleBtw?: () => void;
}) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const socketStatus = useSocketStatus();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const ime = useImeGuard();
    const isTablet = useIsTablet();

    const meta = session?.metadata;
    const title = meta?.summary?.text?.trim() || t('session.newChat');
    const host = meta?.host;
    const cwd = meta?.path;
    const status = connectionStatus(session?.presence, socketStatus);
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
    const relayLabel = relayRegionLabel(relayStatus, getServerUrl());

    const startEdit = () => {
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
                return { key, label: t('session.chat.files'), icon: FolderTree, checked: !!filesOpen, onSelect: () => onToggleFiles?.() };
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
                        className={`ch-icon ch-files-toggle${filesOpen ? ' is-active' : ''}`}
                        onClick={onToggleFiles}
                        aria-label={t('session.chat.files')}
                        title={t('session.chat.files')}
                        aria-pressed={filesOpen}
                    >
                        <FolderTree size={16} />
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
                ) : (
                    <button type="button" className="ch-title-btn" onClick={startEdit} title={t('session.renameTitle')}>
                        <span className="ch-title">{title}</span>
                        <Pencil size={13} className="ch-title-pencil" />
                    </button>
                )}
                {(host || cwd) && (
                    <div className="ch-crumb">
                        {host && <span className="ch-crumb-host">{host}</span>}
                        {host && cwd && <span className="ch-crumb-sep">·</span>}
                        {cwd && <span className="ch-crumb-cwd">{cwd}</span>}
                    </div>
                )}
            </div>
            {/* Rename takes the whole bar: with the status pill and icons in
                place the input measured 4px wide at 360px — unusable. */}
            {!editing && (
                <div className="ch-status">
                    <span className="ch-relay" title={t('session.chat.relayRegion')}>{relayLabel}</span>
                    <StatusDot status={status} size={9} pulse={status === 'connected'} />
                </div>
            )}
            {!editing && plan.inline.map(renderAction)}
            {!editing && plan.overflow.length > 0 && (
                <ActionDropdownMenu items={plan.overflow.map(menuItem)}>
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
        </header>
    );
}
