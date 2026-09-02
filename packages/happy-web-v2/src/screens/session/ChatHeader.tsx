/**
 * ChatHeader — title (editable rename), machine·cwd breadcrumb, connection dot,
 * and the global back button.
 */
import { useEffect, useState } from 'react';
import { StickyNote, Check, FolderTree, MessageCircleQuestion, Pencil, X } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useSession } from '@/sync/storage';
import { useSocketStatus } from '@/app/useConnection';
import { sessionUpdateTitle } from '@/sync/ops';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner, StatusDot, type Status } from '@/ui';
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
    /** B-279 `/btw` side-question panel; absent = this session can't host it */
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
            <div className="ch-status">
                <span className="ch-relay" title={t('session.chat.relayRegion')}>{relayLabel}</span>
                <StatusDot status={status} size={9} pulse={status === 'connected'} />
            </div>
            {/* B-115: quick notes entry — the dock's only reachable entry on
                mobile (⌘J / sidebar footer don't exist there). */}
            <button
                type="button"
                className="ch-icon"
                onClick={toggleNotesPanel}
                aria-label={t('notes.title')}
                title={t('notes.title')}
            >
                <StickyNote size={16} />
            </button>
            {onToggleBtw && (
                <button
                    type="button"
                    className={`ch-icon ch-btw-toggle${btwOpen ? ' is-active' : ''}`}
                    onClick={onToggleBtw}
                    aria-label={t('session.btw.title')}
                    title={t('session.btw.headerHint')}
                    aria-pressed={btwOpen}
                >
                    <MessageCircleQuestion size={16} />
                </button>
            )}
            {onToggleFiles && (
                <button
                    type="button"
                    className={`ch-icon ch-files-toggle${filesOpen ? ' is-active' : ''}`}
                    onClick={onToggleFiles}
                    aria-label={t('session.chat.files')}
                    title={t('session.chat.files')}
                    aria-pressed={filesOpen}
                >
                    <FolderTree size={16} />
                </button>
            )}
        </header>
    );
}
