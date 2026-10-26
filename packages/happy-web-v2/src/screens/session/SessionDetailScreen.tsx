import { ProjectSuggestionBanner } from '@/screens/projects/ProjectSuggestionBanner';
import { QuickSessionProjectBanner } from '@/screens/projects/QuickSessionProjectBanner';
import { isQuickSession } from '@/screens/projects/newSessionProject';
import { SessionPreviews } from './SessionPreviews';
import { SubagentDock } from './SubagentDock';
import { PermissionCard } from './PermissionCard';
import { messageActionsCopy } from './messageActionsCopy';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useSession, useMessage, useLocalSetting, useIsDataReady, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useKeyboardViewportPin } from '@/app/useKeyboardViewportPin';
import { useMediaQuery } from '@/app/useMediaQuery';
import { boardFoldAction } from './board/boardFold';
import { useFilesPanelWidth } from '@/screens/files/useFilesPanelWidth';
import { useTranslation } from '@/i18n/useTranslation';
import { EmptyState, Button, OrbitLoader, toast } from '@/ui';
import { LeadViewStripToggle, SessionTeamContext } from './SessionTeamContext';
import { ChatHeader } from './ChatHeader';
import { ChatList } from './ChatList';
import { AgentInput, type PendingComposer } from './AgentInput';
import { useAfterSplashPaint } from '@/app/afterSplashPaint';
import { PendingSessionBody, PendingSessionHeader } from './PendingSessionParts';
import { composerKey, isPendingSessionId, landingRedirect } from '@/sync/pendingSessions';
import { clearPendingSessionKeys, pendingDraft, pendingSessions, usePendingRecord } from '@/sync/pendingSessionsRuntime';
import { notesPanelTransition, type NotesPanelSnapshot } from './notesPanelTransition';
import { setNotesPanelOpen } from '../notes/notesPanelState';
import { SessionWorkspacePanel } from './SessionWorkspacePanel';
import { HumanAttentionBanner } from './HumanAttentionBanner';
import { QuickOpen } from '../quickopen/QuickOpen';
import { useRetainedWorkspace } from '../workspace/useRetainedWorkspace';
import { onBtwOpen } from './btwPanelState';
import { onSubagentOpen } from './subagentPanelState';
import { canOfferBtw, supportsBtw } from './btwCommand';
import { btwStore } from '@/sync/btwStore';
import { MirrorBanner } from './MirrorBanner';
import { MirrorInputBar } from './MirrorInputBar';
import { SharedSessionBanner } from './SharedSessionBanner';
import { SharedComposer } from './SharedComposer';
import { canSendAsGrantee, isSharedWithMe } from '@/app/sessionAccess';
import { SessionArchivedBanner } from './SessionArchivedBanner';
import { StaleWrapperBanner } from './StaleWrapperBanner';
import { ModelSupportBanner } from './ModelSupportBanner';
import { AutomationAttentionBanner } from './AutomationAttentionBanner';
import { WorktreeSetupBanner } from './WorktreeSetupBanner';
import { canOfferRestore } from '@/app/sessionRestore';
import { useHibernationAutoWake } from '@/app/useHibernationAutoWake';
import { isMirrorSession } from '@/assistant/assistantSession';
import { newSessionTimingComposerMounted, newSessionTimingInStore, newSessionTimingPendingShown } from '@/app/newSessionTiming';
import { isHistoryPanel, readSessionPanel, readSubagentTarget, toggleHistoryPanel, withSessionPanel, withSubagentPanel, type SessionPanelTab } from './sessionPanelState';
import { ChatBackdrop } from './ChatBackdrop';
import { BoardHeaderButton, BoardMobile } from './board/BoardMobile';
import { loadAttentionItems, useAttentionStore } from '@/sync/attentionStore';
import { useSessionBoard } from './board/useSessionBoard';
import { BackButton } from '@/app/BackButton';
import { sessionGate, shouldLookUpSession, type SessionLookup } from './sessionLookup';
import { ChatSyncStatus } from './ChatSyncStatus';
import './session.css';

/** The transcript's frame (ChatList's own empty layout) for the one cold-start paint before it renders. */
function ColdTranscriptPlaceholder() {
    return <div className="cl cl--loading"><div className="cl-scroll"><div className="cl-inner" /></div></div>;
}

export function SessionDetailScreen() {
    const { id: routeId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { t, lang } = useTranslation();
    // B-823 (QA9 O-2): under the cold-start splash the composer commits first, the transcript after that paint.
    const transcriptNow = useAfterSplashPaint();
    // B-516 single tree: a pending record (optimistic new session) renders this
    // same layout. `id` is the effective id — the pending id until the outbox
    // is flushed, then its real id (the composer only switches then, so a new
    // message can never overtake the outbox).
    const pending = usePendingRecord(routeId);
    const pendingMode = !!pending && pending.state !== 'landed';
    const id = pending
        ? (pending.state === 'landed' && pending.realId ? pending.realId : pending.pendingId)
        : routeId;
    const pendingId = pendingMode ? pending!.pendingId : null;
    const session = useSession(id ?? '');
    const quickSession = useMemo(() => !!id && isQuickSession(id), [id]);
    const branchOrigin = useMessage(session?.metadata?.parentSessionId ?? '', session?.metadata?.forkedFromMessageId ?? '');
    const bannerMachine = storage((s) => {
        const mid = session?.metadata?.machineId;
        return mid ? s.machines[mid] : undefined;
    });
    // B-587: opening a hibernated session wakes it.
    useHibernationAutoWake(pendingMode ? undefined : id);
    const [searchParams, setSearchParams] = useSearchParams();
    const panelTab = readSessionPanel(searchParams.get('panel'));
    const notesOpen = useLocalSetting('notesPanelOpen');
    const notesTransition = useRef<NotesPanelSnapshot|null>(null);
    // One aside, two tenants: the files panel (three tabs) or the `/btw`
    // side-question panel (B-283). `filesOpen` drives the files toggle only.
    // `?panel=btw` on a session that cannot host it (codex/gemini, terminal
    // mirror, pasted URL) is ignored rather than mounting a dead panel.
    // B-619: a session shared WITH me has no machine access from this account —
    // no files panel, no /btw, no session RPC of any kind.
    const sharedWithMe = !!session && isSharedWithMe(session);
    // B-619: the owner withdrew the share (or deleted the session) while I was
    // looking at it — the row is purged by sync; say so and go home instead of
    // leaving a spinner that would wait forever.
    const wasSharedRef = useRef(false);
    useEffect(() => {
        if (sharedWithMe) { wasSharedRef.current = true; return; }
        if (wasSharedRef.current && !session && !pendingMode) {
            wasSharedRef.current = false;
            toast.error(t('share.revokedToast'));
            navigate('/', { replace: true });
        }
    }, [sharedWithMe, session, pendingMode, navigate, t]);
    const btwAllowed = !!session && !isMirrorSession(session) && !sharedWithMe && canOfferBtw(session);
    const btwOpen = panelTab === 'btw' && btwAllowed;
    // B-512 timing: store arrival (fallback when the update path didn't mark
    // it) and composer mount end a pending new-session trace. Effects run
    // after children mount, so AgentInput is on screen here. No-ops unless a
    // new-session trace for this id is open.
    const composerShown = !!session && !isMirrorSession(session) && !sharedWithMe;
    useEffect(() => {
        if (!id || !session || pendingMode) return;
        newSessionTimingInStore(id);
        if (composerShown) newSessionTimingComposerMounted(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only the presence edge matters
    }, [id, !!session, composerShown]);
    // B-317: the sub-agent drawer is a third tenant. It is only ever opened by
    // clicking a card, so a `?panel=agent` without a target is not a panel.
    const subagentTarget = panelTab === 'subagent' ? readSubagentTarget(searchParams) : null;
    const subagentOpen = subagentTarget !== null;
    const historyTab = isHistoryPanel(panelTab) ? panelTab : null;
    // B-766: the 汇报板 — only where the server has the feature and the session holds items / advertises the board tools.
    const hasBoard = useSessionBoard(id ?? '');
    const boardAllowed = hasBoard && !!session && !isMirrorSession(session) && !sharedWithMe;
    const boardLoadable = !!id && !!session && !pendingMode && !isMirrorSession(session) && !sharedWithMe;
    useEffect(() => { if (boardLoadable) void loadAttentionItems(id!); }, [id, boardLoadable]);
    const boardOpen = panelTab === 'board' && boardAllowed;
    const boardPhone = useMediaQuery('(max-width: 767px)');
    const [boardSheet, setBoardSheet] = useState(false);
    const filesOpen = panelTab !== null && panelTab !== 'btw' && panelTab !== 'subagent' && panelTab !== 'notes' && panelTab !== 'board' && !historyTab;
    const panelOpen = btwOpen || filesOpen || subagentOpen || panelTab === 'notes' || boardOpen || !!historyTab;
    const retainedPanel = useRetainedWorkspace(id ?? '', panelOpen ? { tab: panelTab!, subagentTarget } : null);
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
    // URL owns the visible pane; notesPanelOpen remains the global shortcut signal.
    useEffect(() => {
        const current = {id,panel:panelTab,open:notesOpen};
        const action = notesPanelTransition(notesTransition.current,current);
        notesTransition.current = current;
        if (action.open !== undefined) setNotesPanelOpen(action.open);
        if ('panel' in action) setPanelRef.current(action.panel ?? null,true);
    }, [id,panelTab,notesOpen]);
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
    // B-766: 「看板 ›」 on a transcript pointer opens the board on that item —
    // the top sheet on phones, the aside tab elsewhere.
    const boardPhoneRef = useRef(boardPhone);
    boardPhoneRef.current = boardPhone;
    const panelTabRef = useRef(panelTab);
    panelTabRef.current = panelTab;
    useEffect(() => {
        if (!id) return;
        return useAttentionStore.subscribe((state, prev) => {
            const focus = state.focus;
            if (!focus || focus === prev.focus || focus.sessionId !== id) return;
            if (boardPhoneRef.current) setBoardSheet(true);
            else if (panelTabRef.current !== 'board') setPanelRef.current('board', panelTabRef.current !== null);
        });
    }, [id]);
    // B-795: a fold / unfold moves an open board to its other home instead of closing it.
    const boardPhonePrev = useRef(boardPhone);
    useEffect(() => {
        const prev = boardPhonePrev.current;
        boardPhonePrev.current = boardPhone;
        const action = boardFoldAction(prev, boardPhone, { sheetOpen: boardSheet, panelIsBoard: panelTabRef.current === 'board' });
        if (action === 'sheet-to-panel' && boardAllowed) setPanelRef.current('board', true); // a fold is not a navigation: replace
        else if (action === 'panel-to-sheet') { setPanelRef.current(null, true); setBoardSheet(true); }
        if (!boardPhone) setBoardSheet(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the phone ↔ wide crossing only
    }, [boardPhone]);
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
    // Desktop (>=1100px, matching session.css): the files panel is an inline
    // right sidebar — draggable width, persisted in localSettings.filesPanelWidth
    // (shared with the terminal's file browser, B-088). Narrow viewports keep
    // the full overlay: no handle, no inline width.
    const filesWide = useMediaQuery('(min-width: 1100px)');
    // B-609: the handle is a pointer-event separator, so wide touch screens
    // (iPad) get it too (coarse pointers get a wider hit area in CSS).
    const filesResizable = filesWide;
    // Dragging past the collapse threshold closes the aside through the same
    // path as the scrim / close button; the stored width is left untouched.
    const { width: filesWidth, collapseArmed: filesCollapseArmed, handleProps: filesHandleProps } = useFilesPanelWidth({
        onCollapse: () => setPanelRef.current(null, true),
    });
    // iOS: while the soft keyboard is up, pin this screen to the visual
    // viewport so the composer sits above the keyboard and the message list's
    // scroll math matches what's actually visible (see the hook's write-up).
    const sdRef = useRef<HTMLDivElement>(null);
    useKeyboardViewportPin(sdRef);

    // B-516: the pending page is on screen → end the global new-chat lock
    // and record the pending-shown mark; failures while here need no toast.
    useEffect(() => {
        if (!pendingId) return;
        pendingSessions.markShown(pendingId);
        newSessionTimingPendingShown();
        pendingSessions.setViewing(pendingId);
        return () => {
            pendingSessions.setViewing(null);
            // B-801: leaving a draft leaves nothing behind (its text is stashed for
            // the next 「新会话」). After the composer's unmount flush; a remount
            // that shows the same draft again (StrictMode, quick back) keeps it.
            setTimeout(() => { pendingSessions.leaveDraft(pendingId); }, 0);
        };
    }, [pendingId]);
    // Only THIS page, while it still shows the pending id, moves on to the
    // real session (replace, search kept). A user who left is never pulled back.
    const redirectTo = landingRedirect(routeId, pending);
    useEffect(() => {
        if (redirectTo) navigate(`/session/${redirectTo}${location.search}`, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on the landing edge only
    }, [redirectTo]);
    // pendingId -> its realId: the composer instance is kept (same key); drop
    // what it left under the pending id (runs after the composer's own cleanup).
    const previousId = useRef(id);
    useEffect(() => {
        const previous = previousId.current;
        previousId.current = id;
        if (previous && previous !== id && isPendingSessionId(previous) && id && pendingSessions.aliasOf(id) === previous) {
            clearPendingSessionKeys(previous);
        }
    }, [id]);
    // A record another tab owns is read-only here; if that tab is gone, take it over.
    const foreignPending = pendingMode && !pendingSessions.isOwnedHere(pending!.pendingId);
    useEffect(() => {
        if (foreignPending) void pendingSessions.resume();
    }, [foreignPending]);
    const pendingInitialDraft = useMemo(() => (pendingId ? pendingDraft(pendingId) : ''), [pendingId]);
    // B-801: back / forward to a draft page this tab left → the same draft again, text included.
    const reopenable = isPendingSessionId(routeId) && !pending && pendingSessions.canReopenDraft(routeId!);
    useEffect(() => {
        if (reopenable) pendingSessions.reopenDraft(routeId!);
    }, [reopenable, routeId]);

    // B-798 P1-8: an id the loaded list does not have → ask the server for it
    // (old sessions fall outside the list's 150 rows); only a 404 is 「不存在」.
    const dataReady = useIsDataReady();
    const [lookup, setLookup] = useState<{ id: string | undefined; state: SessionLookup; attempt: number }>({ id, state: 'idle', attempt: 0 });
    const lookupState: SessionLookup = lookup.id === id ? lookup.state : 'idle';
    const lookupAttempt = lookup.id === id ? lookup.attempt : 0;
    useEffect(() => {
        if (!id || !shouldLookUpSession({ dataReady, inStore: !!session, pending: !!pending, lookup: lookupState })) return;
        let live = true;
        setLookup({ id, state: 'checking', attempt: lookupAttempt });
        sync.fetchSessionById(id)
            .then((result) => { if (live) setLookup({ id, state: result === 'missing' ? 'missing' : 'idle', attempt: lookupAttempt }); })
            .catch(() => { if (live) setLookup({ id, state: 'failed', attempt: lookupAttempt }); });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- lookupState is read, not watched: the 'checking' write must not cancel its own request
    }, [id, dataReady, !!session, !!pending, lookupAttempt]);

    // Trigger the initial message fetch + mark this session as the one being
    // viewed (drives message sync, read state, and web-resume refresh).
    // Skipped while pending: there is no session to fetch or mark read.
    useEffect(() => {
        if (!id || pendingMode) return;
        storage.getState().setCurrentViewingSession(id);
        sync.onSessionEnter(id);
        return () => {
            if (storage.getState().currentViewingSessionId === id) {
                storage.getState().setCurrentViewingSession(null);
            }
        };
    }, [id, pendingMode]);

    if (!id) {
        return (
            <EmptyState
                title={t('common.error')}
                actions={<Button onClick={() => navigate('/')}>{t('common.back')}</Button>}
            />
        );
    }

    // A pending id without a record: discarded, or opened in another browser.
    if (reopenable) return null;
    if (isPendingSessionId(routeId) && !pending) {
        return (
            <EmptyState
                title={t('pendingSession.goneTitle')}
                actions={<Button onClick={() => navigate('/')}>{t('common.back')}</Button>}
            />
        );
    }

    // Session not yet in storage: still syncing, being looked up, or gone (B-798 P1-8).
    if (!session && !pending) {
        const gate = sessionGate({ dataReady, lookup: lookupState });
        return (
            <div className="sd-loading" data-gate={gate}>
                <BackButton />
                {gate === 'loading' ? (
                    <>
                        <OrbitLoader size="compact" label={t('session.chat.loadingMessages')} />
                        {import.meta.env.DEV && <span className="sd-loading__id mono">Session {id}</span>}
                    </>
                ) : (
                    <EmptyState
                        title={gate === 'missing' ? t('session.notFoundTitle') : t('session.loadFailedTitle')}
                        actions={gate === 'missing'
                            ? <Button onClick={() => navigate('/', { replace: true })}>{t('common.home')}</Button>
                            : <Button onClick={() => setLookup({ id, state: 'idle', attempt: lookupAttempt + 1 })}>{t('common.retry')}</Button>}
                    />
                )}
            </div>
        );
    }

    // B-105 terminal mirror: strictly read-only. The composer ROW is absent —
    // not disabled — (AgentInput.canSend ignores presence, a live composer on
    // a daemon-hosted mirror WILL misfire), which also makes the model /
    // permission / effort menus unreachable. Banners replace the foot's role.
    const mirror = !!session && isMirrorSession(session);
    const pendingComposer: PendingComposer | undefined = pendingMode && pending ? {
        onSend: (text) => pendingSessions.append(pending.pendingId, text),
        permissionMode: pending.permissionMode,
        modelMode: pending.modelMode,
        effortLevel: pending.effortLevel,
        onMode: (field, value) => pendingSessions.setMode(pending.pendingId, field, value),
        initialDraft: pendingInitialDraft,
        isGone: () => !pendingSessions.get(pending.pendingId),
        blockedHint: foreignPending
            ? t('pendingSession.otherTab')
            : pending.state === 'failed' ? (pending.deferred ? t('pendingSession.failedDraftKept') : t('pendingSession.retryFirst')) : undefined,
    } : undefined;

    return (
        <div className={`sd${panelOpen && session ? ' sd--files-open' : ''}`} ref={sdRef} data-pending={pending && !session ? pending.state : undefined}>
            <div className="sd-main">
                {session?.metadata?.parentSessionId && <div className="msg-branch-context"><span>{messageActionsCopy(lang).branchContext}</span>{branchOrigin?.kind === 'user-text' && <q className="msg-branch-preview" title={branchOrigin.text}>{branchOrigin.text}</q>}<Link className="msg-parent-link" to={`/session/${session.metadata.parentSessionId}`}>{messageActionsCopy(lang).parent}</Link></div>}
                {!session ? <PendingSessionHeader record={pending!} /> : <ChatHeader
                    sessionId={id}
                    filesOpen={filesOpen}
                    onToggleFiles={sharedWithMe ? undefined : () => panelTab === 'browse' ? setPanel(null, true) : setPanel('browse')}
                    btwOpen={btwOpen}
                    onToggleBtw={btwAllowed
                        ? () => (btwOpen ? setPanel(null, true) : setPanel('btw'))
                        : undefined}
                    boardAction={boardAllowed ? <BoardHeaderButton sessionId={id} active={boardPhone ? boardSheet : boardOpen}
                        onClick={() => boardPhone ? setBoardSheet((v) => !v) : boardOpen ? setPanel(null, true) : setPanel('board', panelOpen)} /> : undefined}
                />}
                {/* B-766: phones get the 汇报板 as a summary strip + top sheet under the header. */}
                {boardAllowed && boardPhone && <BoardMobile key={`board:${id}`} sessionId={id} open={boardSheet} onOpenChange={setBoardSheet} trailing={<LeadViewStripToggle sessionId={id} />} />}
                {session && <SessionTeamContext sessionId={id} />}
                {mirror && <MirrorBanner sessionId={id} />}
                {/* B-619: whose session this is and what I may do here. */}
                {sharedWithMe && <SharedSessionBanner sessionId={id} />}
                {/* B-508: an automation run is waiting on this session → say which and offer 「知道了」.
                    Sibling keys MUST differ (`<slot>:<id>`, never a bare id): `.sd-main` has false holes,
                    so React reconciles it by key map, and two same-key siblings orphan one fiber —
                    its DOM stays and a fresh copy is inserted on every re-render (duplicated strip). */}
                {session && !mirror && !sharedWithMe && <AutomationAttentionBanner key={`automation-attention:${id}`} sessionId={id} />}
                {/* B-649: folder belongs to a project this session is not in → suggest (never auto-join).
                    B-757: a 快捷新建 session instead says where it landed (project or none), once. */}
                {session && !mirror && !sharedWithMe && (quickSession
                    ? <QuickSessionProjectBanner key={`quick-project:${id}`} sessionId={id} />
                    : <ProjectSuggestionBanner key={`project-suggestion:${id}`} sessionId={id} />)}
                {/* B-510: an agent asked for a person (request_human). */}
                {session && !mirror && <HumanAttentionBanner key={`human-attention:${id}`} sessionId={id} />}
                {/* recoverability: inactive session (archived OR offline) → restore banner */}
                {session && !mirror && !sharedWithMe && canOfferRestore(session, bannerMachine) && <SessionArchivedBanner sessionId={id} />}
                {/* B-462: live session still on an older wrapper than the machine runs → offer a restart */}
                {session && !mirror && !sharedWithMe && !canOfferRestore(session, bannerMachine) && <StaleWrapperBanner sessionId={id} />}
                {/* B-487: the wanted model cannot run on this wrapper / agent CLI → say so and offer the fix */}
                {session && !mirror && !sharedWithMe && !canOfferRestore(session, bannerMachine) && <ModelSupportBanner sessionId={id} />}
                {/* B-585: this session's worktree setup is waiting for approval / running / failed */}
                {session && !mirror && !sharedWithMe && <WorktreeSetupBanner key={`worktree-setup:${id}`} sessionId={id} />}
                <div className="sd-body">
                    {/* B-752: calm ASCII field behind the transcript (fixed, not scrolled). */}
                    <ChatBackdrop sessionId={id} />
                    {session
                        ? (transcriptNow ? <ChatList key={id} sessionId={id} showLiveStatus={!mirror} /> : <ColdTranscriptPlaceholder />)
                        : <PendingSessionBody record={pending!} />}
                    {session && <ChatSyncStatus sessionId={id} />}
                </div>
                {!mirror && !sharedWithMe && (
                    <div className="sd-foot">
                        {/* B-602: count chips only; the records open in the aside (toggle, replace while it is open). */}
                        {session && <SessionPreviews sessionId={id} active={historyTab}
                            onToggle={tab => setPanel(toggleHistoryPanel(panelTab, tab), panelOpen)} />}
                        {session && <SubagentDock sessionId={id} />}
                        {/* B-563: pending approvals / questions stay pinned right
                            above the composer while the transcript scrolls. */}
                        {session && <PermissionCard key={`permission:${id}`} sessionId={id} />}
                        {/* Queue/draft/attachment ownership is session-scoped.
                            Force a clean composer instance when the session changes so
                            an unsent item can never cross into another session. The one
                            allowed id change without remount is a pending id -> its own
                            real id (B-516), keyed by the pending alias. */}
                        <AgentInput
                            key={composerKey(id, pendingSessions.aliasOf)}
                            sessionId={id}
                            agentFlavor={session ? undefined : pending?.agent}
                            pending={pendingComposer}
                        />
                    </div>
                )}
                {/* B-107: the mirror's only interactive surface — a pty-channel
                    input bar (NOT a session composer; the mirror session stays
                    read-only, input flows back via the transcript). The bar
                    self-hides when the terminal is gone or claude exited. */}
                {mirror && <MirrorInputBar sessionId={id} />}
                {/* B-619: a driver's only write path; viewers get nothing below the transcript.
                    PermissionCard is deliberately absent — approvals stay with the owner. */}
                {sharedWithMe && session && canSendAsGrantee(session) && <SharedComposer sessionId={id} />}
            </div>
            {retainedPanel && session && (
                <>
                    {panelOpen && <div className="sd-files-scrim" onClick={() => setPanel(null, true)} aria-hidden />}
                    {panelOpen && filesResizable && (
                        <div className="app-resize-handle sd-files-handle" {...filesHandleProps} />
                    )}
                    <aside className={`sd-files${filesCollapseArmed ? ' sd-files--collapse-armed' : ''}`} hidden={!panelOpen} style={{ ...(filesWide ? { width: filesWidth } : {}), ...(!panelOpen ? { display: 'none' } : {}) }}>
                        <SessionWorkspacePanel key={id} sessionId={id} visible={panelOpen} panel={retainedPanel.tab} subagentTarget={retainedPanel.subagentTarget}
                            btwAllowed={btwAllowed} onPanel={tab=>setPanel(tab,true)}
                            onSubagent={messageId=>openSubagent(messageId,true)} onClose={()=>setPanel(null,true)}/>

                    </aside>
                </>
            )}
            {/* B-576 ⌘P quick open: mounted here so its ⌘P/Ctrl+P interception exists only on the session page. */}
            {session && id && !pendingMode && <QuickOpen sessionId={id} />}
        </div>
    );
}
