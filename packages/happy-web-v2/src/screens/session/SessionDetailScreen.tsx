import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSession, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useTranslation } from '@/i18n/useTranslation';
import { EmptyState, Button } from '@/ui';
import { ChatHeader } from './ChatHeader';
import { ChatList } from './ChatList';
import { SessionLiveStatusBar } from './SessionLiveStatusBar';
import { AgentInput } from './AgentInput';
import { FilesPanel } from './FilesPanel';
import './session.css';

export function SessionDetailScreen() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const session = useSession(id ?? '');
    const [filesOpen, setFilesOpen] = useState(false);

    // Trigger the initial message fetch + mark this session as the one being
    // viewed (drives message sync, read state, and web-resume refresh).
    useEffect(() => {
        if (!id) return;
        storage.getState().setCurrentViewingSession(id);
        sync.onSessionVisible(id);
        return () => {
            if (storage.getState().currentViewingSessionId === id) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [id]);

    if (!id) {
        return (
            <EmptyState
                title={t('common.error' as any)}
                actions={<Button onClick={() => navigate('/')}>{t('common.back' as any)}</Button>}
            />
        );
    }

    // Session not yet in storage (still syncing or unknown id).
    if (!session) {
        return (
            <EmptyState
                title={t('session.chat.loadingMessages' as any)}
                description={`Session ${id}`}
                actions={<Button variant="ghost" onClick={() => navigate('/')}>{t('common.back' as any)}</Button>}
            />
        );
    }

    return (
        <div className={`sd${filesOpen ? ' sd--files-open' : ''}`}>
            <div className="sd-main">
                <ChatHeader
                    sessionId={id}
                    onBack={() => navigate('/')}
                    filesOpen={filesOpen}
                    onToggleFiles={() => setFilesOpen((v) => !v)}
                />
                <div className="sd-body">
                    <ChatList sessionId={id} />
                </div>
                <div className="sd-foot">
                    <SessionLiveStatusBar sessionId={id} />
                    <AgentInput sessionId={id} />
                </div>
            </div>
            {filesOpen && (
                <>
                    <div className="sd-files-scrim" onClick={() => setFilesOpen(false)} aria-hidden />
                    <aside className="sd-files">
                        <FilesPanel sessionId={id} onClose={() => setFilesOpen(false)} />
                    </aside>
                </>
            )}
        </div>
    );
}
