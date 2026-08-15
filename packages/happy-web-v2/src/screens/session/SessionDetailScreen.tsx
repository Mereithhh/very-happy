import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSession, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useFilesPanelWidth } from '@/screens/files/useFilesPanelWidth';
import { useTranslation } from '@/i18n/useTranslation';
import { EmptyState, Button } from '@/ui';
import { ChatHeader } from './ChatHeader';
import { ChatList } from './ChatList';
import { SessionLiveStatusBar } from './SessionLiveStatusBar';
import { AgentInput } from './AgentInput';
import { FilesPanel } from './FilesPanel';
import { MirrorBanner } from './MirrorBanner';
import { MirrorInputBar } from './MirrorInputBar';
import { isMirrorSession } from '@/assistant/assistantSession';
import './session.css';

export function SessionDetailScreen() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const session = useSession(id ?? '');
    const [filesOpen, setFilesOpen] = useState(false);
    // Desktop (>860px, matching session.css): the files panel is an inline
    // right sidebar — draggable width, persisted in localSettings.filesPanelWidth
    // (shared with the terminal's file browser, B-088). Narrow viewports keep
    // the full overlay: no handle, no inline width.
    const filesWide = useMediaQuery('(min-width: 861px)');
    // The drag handle needs a mouse — touch devices (wide iPad) keep the plain
    // sidebar without it.
    const filesResizable = useMediaQuery('(min-width: 861px) and (pointer: fine)');
    const { width: filesWidth, onHandleMouseDown: onFilesHandleDown } = useFilesPanelWidth();
    // iOS: while the soft keyboard is up, pin this screen to the visual
    // viewport so the composer sits above the keyboard and the message list's
    // scroll math matches what's actually visible (see the hook's write-up).
    const sdRef = useRef<HTMLDivElement>(null);
    useKeyboardViewportPin(sdRef);

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
                title={t('common.error')}
                actions={<Button onClick={() => navigate('/')}>{t('common.back')}</Button>}
            />
        );
    }

    // Session not yet in storage (still syncing or unknown id).
    if (!session) {
        return (
            <EmptyState
                title={t('session.chat.loadingMessages')}
                description={`Session ${id}`}
                actions={<Button variant="ghost" onClick={() => navigate('/')}>{t('common.back')}</Button>}
            />
        );
    }

    // B-105 terminal mirror: strictly read-only. The composer ROW is absent —
    // not disabled — (AgentInput.canSend ignores presence, a live composer on
    // a daemon-hosted mirror WILL misfire), which also makes the model /
    // permission / effort menus unreachable. Banners replace the foot's role.
    const mirror = isMirrorSession(session);

    return (
        <div className={`sd${filesOpen ? ' sd--files-open' : ''}`} ref={sdRef}>
            <div className="sd-main">
                <ChatHeader
                    sessionId={id}
                    filesOpen={filesOpen}
                    onToggleFiles={() => setFilesOpen((v) => !v)}
                />
                {mirror && <MirrorBanner sessionId={id} />}
                <div className="sd-body">
                    <ChatList sessionId={id} />
                </div>
                {!mirror && (
                    <div className="sd-foot">
                        <SessionLiveStatusBar sessionId={id} />
                        <AgentInput sessionId={id} />
                    </div>
                )}
                {/* B-107: the mirror's only interactive surface — a pty-channel
                    input bar (NOT a session composer; the mirror session stays
                    read-only, input flows back via the transcript). The bar
                    self-hides when the terminal is gone or claude exited. */}
                {mirror && <MirrorInputBar sessionId={id} />}
            </div>
            {filesOpen && (
                <>
                    <div className="sd-files-scrim" onClick={() => setFilesOpen(false)} aria-hidden />
                    {filesResizable && (
                        <div
                            className="app-resize-handle sd-files-handle"
                            onMouseDown={onFilesHandleDown}
                            role="separator"
                            aria-orientation="vertical"
                        />
                    )}
                    <aside className="sd-files" style={filesWide ? { width: filesWidth } : undefined}>
                        <FilesPanel sessionId={id} onClose={() => setFilesOpen(false)} />
                    </aside>
                </>
            )}
        </div>
    );
}
