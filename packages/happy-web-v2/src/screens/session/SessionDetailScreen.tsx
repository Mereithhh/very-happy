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
import { BtwPanel } from './BtwPanel';
import { onBtwOpen } from './btwPanelState';
import { SubagentPanel } from './SubagentPanel';
import { onSubagentOpen } from './subagentPanelState';
import { canOfferBtw, supportsBtw } from './btwCommand';
import { btwStore } from '@/sync/btwStore';
import { MirrorBanner } from './MirrorBanner';
import { MirrorInputBar } from './MirrorInputBar';
import { SessionArchivedBanner } from './SessionArchivedBanner';
import { canOfferRestore } from '@/app/sessionRestore';
import { isMirrorSession } from '@/assistant/assistantSession';
import { readSessionPanel, readSubagentTarget, withSessionPanel, withSubagentPanel, type SessionFilesTab, type SessionPanelTab } from './sessionPanelState';
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
    // One aside, two tenants: the files panel (three tabs) or the `/btw`
    // side-question panel (B-283). `filesOpen` drives the files toggle only.
    // `?panel=btw` on a session that cannot host it (codex/gemini, terminal
    // mirror, pasted URL) is ignored rather than mounting a dead panel.
    const btwAllowed = !!session && !isMirrorSession(session) && canOfferBtw(session);
    const btwOpen = panelTab === 'btw' && btwAllowed;
    // B-317: the sub-agent drawer is a third tenant. It is only ever opened by
    // clicking a card, so a `?panel=agent` without a target is not a panel.
    const subagentTarget = panelTab === 'subagent' ? readSubagentTarget(searchParams) : null;
    const subagentOpen = subagentTarget !== null;
    const filesOpen = panelTab !== null && panelTab !== 'btw' && panelTab !== 'subagent';
    const panelOpen = btwOpen || filesOpen || subagentOpen;
    const setPanel = (tab: SessionPanelTab | null, replace = false) => {
        setSearchParams(withSessionPanel(searchParams, tab), { replace });
    };
    const openSubagent = (messageId: string, replace: boolean) => {
        setSearchParams(withSubagentPanel(searchParams, messageId), { replace });
    };
    const openSubagentRef = useRef(openSubagent);
    openSubagentRef.current = openSubagent;
    const subagentOpenRef = useRef(subagentOpen);
    subagentOpenRef.current = subagentOpen;
    const setPanelRef = useRef(setPanel);
    setPanelRef.current = setPanel;
    const btwOpenRef = useRef(btwOpen);
    btwOpenRef.current = btwOpen;
    // Composer `/btw [question]` → open this session's panel (replace, not
    // push, when it is already open) and ask when the wrapper supports it and
    // nothing is running; otherwise park the text as the panel draft so it is
    // never lost (upgrade notice / running question explain why).
    useEffect(() => {
        if (!id) return;
        return onBtwOpen((detail) => {
            if (detail.sessionId !== id) return;
            setPanelRef.current('btw', btwOpenRef.current);
            const question = detail.question?.trim();
            if (!question) return;
            const current = storage.getState().sessions[id];
            const running = btwStore.getState().sessions[id]?.exchanges.some((e) => e.status === 'running') === true;
            if (supportsBtw(current) && !running) void btwStore.getState().ask(id, question);
            else btwStore.getState().setDraft(id, question);
        });
    }, [id]);
    // A sub-agent card anywhere in the transcript opens the drawer on itself.
    // Replace (not push) while the drawer is already open, so switching cards
    // does not stack history entries the back button has to walk through.
    useEffect(() => {
        if (!id) return;
        return onSubagentOpen((detail) => {
            if (detail.sessionId !== id) return;
            openSubagentRef.current(detail.messageId, subagentOpenRef.current);
        });
    }, [id]);
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
        <div className={`sd${panelOpen ? ' sd--files-open' : ''}`} ref={sdRef}>
            <div className="sd-main">
                <ChatHeader
                    sessionId={id}
                    filesOpen={filesOpen}
                    onToggleFiles={() => filesOpen ? setPanel(null, true) : setPanel('changed')}
                    btwOpen={btwOpen}
                    onToggleBtw={btwAllowed
                        ? () => (btwOpen ? setPanel(null, true) : setPanel('btw'))
                        : undefined}
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
            {panelOpen && (
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
                        {subagentOpen ? (
                            <SubagentPanel
                                sessionId={id}
                                messageId={subagentTarget}
                                onClose={() => setPanel(null, true)}
                            />
                        ) : btwOpen ? (
                            <BtwPanel sessionId={id} onClose={() => setPanel(null, true)} />
                        ) : (
                            <FilesPanel
                                sessionId={id}
                                tab={panelTab as SessionFilesTab}
                                onTabChange={(tab) => setPanel(tab, true)}
                                onClose={() => setPanel(null, true)}
                            />
                        )}
                    </aside>
                </>
            )}
        </div>
    );
}
