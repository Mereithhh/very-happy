import { useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { useMediaQuery } from '@/app/useMediaQuery';
import { useFilesPanelWidth } from '@/screens/files/useFilesPanelWidth';
import { useTranslation } from '@/i18n/useTranslation';
import { EmptyState, Button, OrbitLoader } from '@/ui';
import { ChatHeader } from './ChatHeader';
import { ChatList } from './ChatList';
import { AgentInput } from './AgentInput';
import { FilesPanel } from './FilesPanel';
import { MirrorBanner } from './MirrorBanner';
import { MirrorInputBar } from './MirrorInputBar';
import { SessionArchivedBanner } from './SessionArchivedBanner';
import { canOfferRestore } from '@/app/sessionRestore';
import { isMirrorSession } from '@/assistant/assistantSession';
import { readSessionPanel, withSessionPanel, type SessionPanelTab } from './sessionPanelState';
import './session.css';

export function SessionDetailScreen() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const session = useSession(id ?? '');
    const bannerMachine = storage((s) => {
        const mid = session?.metadata?.machineId;
        return mid ? s.machines[mid] : undefined;
    });
    const [searchParams, setSearchParams] = useSearchParams();
    const panelTab = readSessionPanel(searchParams.get('panel'));
    const filesOpen = panelTab !== null;
    const setPanel = (tab: SessionPanelTab | null, replace = false) => {
        setSearchParams(withSessionPanel(searchParams, tab), { replace });
    };
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
            <div className="sd-loading">
                <OrbitLoader size="compact" label={t('session.chat.loadingMessages')} />
                <span className="sd-loading__id mono">Session {id}</span>
                <Button variant="ghost" onClick={() => navigate('/')}>{t('common.back')}</Button>
            </div>
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
                    onToggleFiles={() => filesOpen ? setPanel(null, true) : setPanel('changed')}
                />
                {mirror && <MirrorBanner sessionId={id} />}
                {/* recoverability: inactive session (archived OR offline) → restore banner */}
                {!mirror && canOfferRestore(session, bannerMachine) && <SessionArchivedBanner sessionId={id} />}
                <div className="sd-body">
                    <ChatList key={id} sessionId={id} showLiveStatus={!mirror} />
                </div>
                {!mirror && (
                    <div className="sd-foot">
                        {/* Queue/draft/attachment ownership is session-scoped.
                            Force a clean composer instance when route params change so
                            an unsent item can never cross into another session. */}
                        <AgentInput key={id} sessionId={id} />
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
                    <div className="sd-files-scrim" onClick={() => setPanel(null, true)} aria-hidden />
                    {filesResizable && (
                        <div
                            className="app-resize-handle sd-files-handle"
                            onMouseDown={onFilesHandleDown}
                            role="separator"
                            aria-orientation="vertical"
                        />
                    )}
                    <aside className="sd-files" style={filesWide ? { width: filesWidth } : undefined}>
                        <FilesPanel
                            sessionId={id}
                            tab={panelTab}
                            onTabChange={(tab) => setPanel(tab, true)}
                            onClose={() => setPanel(null, true)}
                        />
                    </aside>
                </>
            )}
        </div>
    );
}
