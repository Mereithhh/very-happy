/**
 * ChatHeader — title (editable rename), machine·cwd breadcrumb, connection dot,
 * and a mobile back button.
 */
import { useState } from 'react';
import { ArrowLeft, Check, Pencil, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSession, useRealtimeStatus } from '@/sync/storage';
import { sessionUpdateTitle } from '@/sync/ops';
import { useTranslation } from '@/i18n/useTranslation';
import { StatusDot, type Status } from '@/ui';
import './header.css';

function connectionStatus(presence: 'online' | number | undefined, realtime: string): Status {
    if (presence !== 'online') return 'offline';
    if (realtime === 'connected') return 'connected';
    return 'offline';
}

export function ChatHeader({ sessionId, onBack }: { sessionId: string; onBack?: () => void }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const realtime = useRealtimeStatus();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);

    const meta = session?.metadata;
    const title = meta?.summary?.text?.trim() || t('session.newChat' as any);
    const host = meta?.host;
    const cwd = meta?.path;
    const status = connectionStatus(session?.presence, realtime);

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
        if (e.key === 'Enter') {
            e.preventDefault();
            void save();
        } else if (e.key === 'Escape') {
            setEditing(false);
        }
    };

    return (
        <header className="ch">
            {(onBack || true) && (
                <button
                    type="button"
                    className="ch-back"
                    onClick={() => (onBack ? onBack() : navigate('/'))}
                    aria-label={t('common.back' as any)}
                >
                    <ArrowLeft size={18} />
                </button>
            )}
            <div className="ch-main">
                {editing ? (
                    <div className="ch-rename">
                        <input
                            className="ch-rename-input"
                            value={draft}
                            autoFocus
                            placeholder={t('session.renamePlaceholder' as any)}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={onKey}
                            disabled={saving}
                        />
                        <button type="button" className="ch-icon" onClick={() => void save()} aria-label={t('common.save' as any)}>
                            <Check size={16} />
                        </button>
                        <button type="button" className="ch-icon" onClick={() => setEditing(false)} aria-label={t('common.cancel' as any)}>
                            <X size={16} />
                        </button>
                    </div>
                ) : (
                    <button type="button" className="ch-title-btn" onClick={startEdit} title={t('session.renameTitle' as any)}>
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
                <StatusDot status={status} size={9} pulse={status === 'connected'} />
            </div>
        </header>
    );
}
