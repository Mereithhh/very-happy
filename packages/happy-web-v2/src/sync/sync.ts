import { supportsSessionAttachments } from './attachmentCapabilities';
import { attentionFromEvent, useHumanAttention } from './humanAttention';
import type { SessionShareInfo } from './sessionShareTypes';
import { useSessionShares } from './sessionSharesStore';
import { uploadContentPublicKey } from './apiSessionShares';
import { encodeBase64 as encodeBase64ForShare } from '@/encryption/base64';
import Constants from 'expo-constants';
import { apiSocket, getCurrentAppState, getHappyClientId } from '@/sync/apiSocket';
import { attachResumeListeners } from '@/sync/resumeSync';
import { setPermissionEnforcer } from '@/sync/storage';
import { runYoloEnforcement } from '@/sync/yoloEnforcer';
import { sanitizeAgentDefaultOverrides } from '@/sync/permissionModeOutbound';
import { resolveIntentSource, shouldAlignToBypass } from '@/sync/yoloEnforcement';
import { getAgentDefaultOverride, getCodeAgentDefaults } from '@/sync/agentDefaults';
import { notifyUnreadMessage } from '@/sync/webTabTitle';
import { stampLocalActivity } from '@/sync/activityOverlayStore';
import { activityKeyForSession } from '@/sync/activityOverlay';
import { HISTORY_PAGE_SIZE, shouldExtendInitialWindow, windowHasTurnStart } from '@/sync/historyWindow';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { isHeartbeatFresh, recordBackgroundTasks, recordHeartbeat, setHeartbeatSocketStatusReader } from '@/sync/heartbeatLease';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { handleClipboardPush } from '@/sync/clipboardPush';
import { handleFilePreviewPush } from '@/sync/filePreviewPush';
import { handleSessionStream } from '@/sync/liveStreamStore';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage, isSessionDeleted } from './storage';
import { markSendConfirmed } from './sendConfirmations';
import { isHiddenSession } from '@/assistant/assistantSession';
import { ApiEphemeralUpdateSchema, ApiMessage, ApiUpdateContainerSchema } from './apiTypes';
import { applyAttentionItem } from './attentionStore';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { syncCurrentPushToken } from './pushRegistration';
import { syncWebPush } from './webPush';
import { getNotificationPrefs } from './notificationPrefs';
import { Platform, AppState, type AppStateStatus } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { buildOutboundUserRecord, readOutboundUserRecord } from './outboundUserRecord';
import { adoptPendingPrompts, applyPromptQueueUpdate, loadPromptQueue, promptQueueStore, promptQueueTranscript, reloadPromptQueue, retryWaitingPrompts, settleDispatchedPrompts } from './promptQueue';
import { isQueueRow } from './promptQueueOutbox';
import type { SessionEncryption } from './encryption/sessionEncryption';
import { forgetCatchUp, trackCatchUp } from './catchUpStatus';
import { isNetworkOffline, startNetworkMonitor } from './networkStatus';
import { fetchWithDeadline, SYNC_READ_TIMEOUT_MS } from './requestDeadline';
import { armHedgeBurst, hedgedRead, hedgePoolInit } from './hedgedRead';
import { catchUpForward, throwIfAborted } from './messageCatchUp';
import { OPEN_BLOCKED_MS, outboxStore, syncCache, type CacheHit } from './cache/syncCache';
import { takeoverAction, type OutboxRow } from './cache/outboxStore';
import { planOutboxAdoption } from './outboxAdoption';
import { isTabAlive, thisTabId, withTabLock } from './tabLiveness';
import { checkCacheAnchor } from './cache/segment';
import { NormalizedMessage, normalizeRawMessage, RawRecord, type SessionEventPayload } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, settingsToSyncPayload, SUPPORTED_SCHEMA_VERSION } from './settings';
import { migrateTerminalCommands } from './shortcutPresets';
import { Profile, profileParse } from './profile';
import { clearDiffCommentDrafts, loadPendingSettings, savePendingSettings } from './persistence';
import {
    initializeTracking,
    trackGitHubConnected,
    trackMessageSent,
    tracking,
} from '@/track';
import type { MessageSentSource } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { getServerUrl } from './serverConfig';
import { log } from '@/log';
import { installRpcRateLimitNotice } from './rpcRateLimitNotice';
import { AsyncLock } from '@/utils/lock';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { hasEditedDraftsBlock, stripEditedDrafts } from './editableDrafts';
import { fetchArtifact, fetchArtifacts, createArtifact, updateArtifact } from './apiArtifacts';
import { DecryptedArtifact, ArtifactCreateRequest, ArtifactUpdateRequest } from './artifactTypes';
import { ArtifactEncryption } from './encryption/artifactEncryption';
import { getFriendsList, getUserProfile } from './apiFriends';
import { fetchFeed } from './apiFeed';
import { FeedItem, FeedBody } from './feedTypes';
import { decryptNotificationEnc } from './encryption/notificationDecrypt';
import { maybeShowNotification } from './webNotifications';
import { maybePlayNotificationSound } from './notificationChime';
import { stampSeenOnArrival } from './seenOnArrival';
import { soundEventOfNotifType } from './notificationInbox';
import { dispatchKvChanges } from './kvUpdates';
import { UserProfile } from './friendTypes';
import { resolveMessageModeMeta, type MessageModeMeta } from './messageMeta';
import type { AttachmentPreview, UploadedAttachment } from './attachmentTypes';
import { preserveSessionBatchActivityFromStore } from './sessionSnapshot';
import { decodeSessionRows, type EncryptedSessionRow } from './sessionDecode';
import { decodeInChunks, rowsToDecode } from './unarchivedApply';
import { adoptSessionListPrefetch, sessionListRequest, takeSessionListPrefetch, type SessionListResponse } from './sessionListPrefetch';
import { catchUpSessionList, DELTA_PAGE_LIMIT, mergeSessionListSnapshot, parseServedAt, sessionListSnapshot, type SessionListSnapshot } from './sessionListDelta';
import { applyNewSessionUpdate } from './newSessionUpdate';
import { newSessionTimingInStore } from '@/app/newSessionTiming';
import { downloadEncryptedAttachment, requestAttachmentUpload, uploadEncryptedBlob } from './apiAttachments';
import { decryptBlob } from '@/encryption/blob';
import { encryptBlob } from '@/encryption/blob';
import { readFileBytes } from '@/utils/readFileBytes';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    emitFirstMachineConnected,
    shouldAnnounceFirstMachine,
} from '@/screens/onboarding/firstMachineWelcome';
import { queuedAtForSend } from './queuedInput';
import { subscribeAuthLatch } from '@/auth/authLatch';
import type { UnsentMessage } from '@/auth/authExpiry';
import {
    assertResponseOk,
    beginSendAttempt,
    interpretSendResponse,
    mapWithConcurrency,
    removeByLocalId,
    settledOutboxRecords,
    SendDeadlines,
} from './outbox';
import { SYNC_ACK_TIMEOUT_MS, type SyncSubResultOk } from '@slopus/happy-wire';
import { createCursor, expireReorder, planMerge, resetCursor, type MergeItem, type MergeMeta, type MergePlan, type MergeSource, type SessionCursor } from './sessionMerge';
import { SessionSyncScheduler, type HelloReason, type SubscribeRequest } from './sessionSyncScheduler';
import type { AckOutcome, SessionSyncState } from './sessionSyncState';
import { cacheProbeAfterSeq, isUsableCacheProbe, type CacheProbe } from './cacheProbe';
import { routedSessionId } from './routedSession';

/**
 * B-819: what rendering a cached run did; `merged` = the anchor probe was checked and applied in
 * the same commit. (B-812: a buffered live update left out past a hole waits in the merge cursor's
 * reorder buffer, whose expiry asks the catch-up — B-819's `droppedMax` reach is that.)
 */
type CacheRender = { merged: { hasMore: boolean } | null };

type V3GetSessionMessagesResponse = {
    messages: ApiMessage[];
    hasMore: boolean;
};

// Sentinel used as `before_seq` for the very first backward fetch of a
// session. It must exceed any real `seq` value the server can produce.
// `seq` is stored as Postgres int4 on the server, so the maximum is
// 2_147_483_647. We use that exact upper bound to keep the request safely
// within int4 while still being effectively "infinite" for any session.
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;

/** B-812: subscribe mode shows 「连接不稳定 · 重试」 once a catch-up is stale for 3s (spec §5.3: 5s ack deadline + 3s). */
const SUBSCRIBE_SLOW_MS = SYNC_ACK_TIMEOUT_MS + 3_000;

const itemMessages = (items: readonly MergeItem<NormalizedMessage>[]): NormalizedMessage[] =>
    items.flatMap((item) => (item.message ? [item.message] : []));

/** B-812 (spec §6.1): `vh.sync.mode=legacy` in this browser's localStorage forces the REST path (diagnosis). */
function forcedLegacySyncMode(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('vh.sync.mode') === 'legacy';
    } catch {
        return false;
    }
}

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type OutboxMessage = {
    localId: string;
    content: string;
    /** B-513: a user retry — skip the regional relay (a restarted wrapper could route it twice). */
    httpOnly?: boolean;
};

/**
 * B-513: a user/file input this client sent, kept until the server confirms it
 * so a failed item can be retried with the same localId (server-side dedupe).
 */
type OutboxRecord = {
    sessionId: string;
    localId: string;
    content: string;
    /** One sendMessage call (attachments + text) — retried together, in order. */
    group: string;
    order: number;
    /** Some earlier attempt may have stored it (timeout, 5xx, lost relay ack…). */
    mayHaveStored: boolean;
    /** An attempt is on the wire right now. */
    attemptInFlight: boolean;
    /**
     * B-722: the plain record of a turn shown before it was encrypted. Kept so
     * a failed encryption can be retried; `content` is '' until then.
     */
    raw?: RawRecord;
};

const SEND_DEADLINE_TICK_MS = 500;
/** B-814: a POST waits at most this long for its outbox row to be durable, then goes anyway. */
const OUTBOX_PERSIST_WAIT_MS = 1_000;
/** B-814: how often a tab looks for outbox rows whose tab has gone away (B-516 uses 30s). */
const OUTBOX_RECLAIM_INTERVAL_MS = 15_000;
/** B-814: adopting rows waits this long for the session's latest page (a stored copy confirms them). */
const OUTBOX_ADOPT_PAGE_WAIT_MS = 10_000;
/**
 * Owner 10-27: after the first list, ready waits up to UNARCHIVED_READY_WAIT_MS
 * for the `scope=unarchived` response to arrive, then up to
 * UNARCHIVED_APPLY_WAIT_MS for its rows to be decoded and merged
 * (fetchUnarchivedSessions). A desktop does both inside the budget, so its
 * first sidebar is the whole list; a phone (the Owner's ~380 rows are ~1.5s of
 * decode + render there) gets in on the window at about the old time and the
 * rest lands in one merge right after — never a drop. On slow 4G a big
 * account's read takes longer and the page gets in on the window first (B-818).
 */
const UNARCHIVED_READY_WAIT_MS = 2_000;
const UNARCHIVED_APPLY_WAIT_MS = 300;

/** Resolves when `promise` settles or after `ms`, whichever is first; never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
}
/** A one-shot signal: `promise` resolves on the first `resolve()`; `settled` tells whether it has. */
function deferredSignal() {
    let resolve!: () => void;
    const signal = { settled: false, promise: new Promise<void>((r) => { resolve = r; }), resolve: () => {} };
    signal.resolve = () => { signal.settled = true; resolve(); };
    return signal;
}
const ATTACHMENT_UPLOAD_CONCURRENCY = 3;

function isBrowserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
}

type SendMessageOptions = {
    displayText?: string;
    source?: MessageSentSource;
    /** Default/queue starts after the current turn; steer targets the live Claude turn. */
    delivery?: 'queue' | 'steer';
    /** Optional opaque file attachments to send before the text message. */
    attachments?: AttachmentPreview[];
    /** Internal composer queue override: preserve the mode selected at enqueue time. */
    modeMeta?: MessageModeMeta;
    /** B-766: a 汇报板 action's message carries `attentionBoardLocalId(...)` so the server's owner-replied rule skips it. */
    localId?: string;
};

/** Which client sent this message — the same answer for a direct send and a queued prompt (B-509). */
function resolveSentFrom(): string {
    if (Platform.OS === 'web') return 'web';
    if (Platform.OS === 'android') return 'android';
    // Check if running on Mac (Catalyst or Designed for iPad on Mac)
    if (Platform.OS === 'ios') return isRunningOnMac() ? 'mac' : 'ios';
    return 'web'; // fallback
}

class Sync {
    private static readonly BACKGROUND_SEND_TIMEOUT_MS = 30_000;
    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    /** B-823: the first socket connect's incremental list catch-up (sessionListDelta.ts). */
    private sessionsCatchUpSync: InvalidateSync;
    /** B-823: what the last full list showed (ids → updatedAt), the catch-up's baseline. */
    private sessionListSnapshot: SessionListSnapshot | null = null;
    /** B-823: this page's socket has connected once (later connects are reconnects). */
    private socketConnectedOnce = false;
    /**
     * B-818 / B-812 S12: settles when the first session list of this load has
     * been applied (re-armed per #init). Neither ready (#init) nor a subscribe ack /
     * cold open waiting for a key (awaitSessionEncryption) waits for the full
     * fetch a resume / reconnect may queue behind it.
     */
    private firstSessionsList = deferredSignal();
    /** Owner 10-27: settles when this load's `scope=unarchived` read has been applied (re-armed per #init). */
    private unarchivedSessionsList = deferredSignal();
    /** Owner 10-27: settles when that read's response is in, before its rows are applied — what ready waits for. */
    private unarchivedSessionsArrived = deferredSignal();
    private unarchivedSessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sendSync = new Map<string, InvalidateSync>();
    private resumeListeners = new Set<() => void>();
    private sendAbortControllers = new Map<string, AbortController>();
    /**
     * B-812: per-session merge cursor — lastSeq (forward catch-up resumes
     * there), oldestSeq (B-616 backward pagination, on demand only), the
     * reorder buffer of live items past a hole (and of B-805's items before
     * the first page). Written by mergeSessionMessages only (sessionMerge.ts).
     */
    private cursors = new Map<string, SessionCursor<NormalizedMessage>>();
    private reorderTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** B-812: the one catch-up scheduler — hello / subscribe / REST (sessionSyncScheduler.ts). */
    readonly syncScheduler: SessionSyncScheduler;
    /** B-812: subscribe-mode catch-up shown in the chat (resolves the trackCatchUp promise). */
    private syncTracking = new Map<string, () => void>();
    private syncPhases = new Map<string, SessionSyncState['phase']>();
    /** B-813: cached runs rendered but not yet checked against the server (the check survives a failed attempt). */
    private unverifiedCacheHits = new Map<string, CacheHit>();
    /** B-813: cached runs read while the session's key was still loading (the read overlaps the session list). */
    private cachePrefetch = new Map<string, { load: Promise<CacheHit | null>; settled: boolean }>();
    /**
     * B-819: the anchor probe of a cached run, asked as soon as the run was
     * read — it needs only the run's newest row, not the session key — so it
     * overlaps the session list and the cache render instead of following them.
     */
    private cacheProbes = new Map<string, CacheProbe>();
    /** B-819: catch-ups that failed for want of the session key; the session list wakes their backoff. */
    private messagesAwaitingKeys = new Set<string>();
    /** B-819: the session a cold open landed on (URL), viewed before its screen mounted. */
    private routedSession: string | null = null;
    private pendingOutbox = new Map<string, OutboxMessage[]>();
    private outboxRecords = new Map<string, OutboxRecord>();
    private outboxOrder = 0;
    /** B-722: per-session encryption chain — outbox items enter `pendingOutbox` in send order. */
    private outboxEncryptChain = new Map<string, Promise<void>>();
    private sendDeadlines = new SendDeadlines();
    private sendDeadlineTimer: ReturnType<typeof setInterval> | null = null;
    /** localIds of the request currently on the wire, per session. */
    private inFlightOutbox = new Map<string, ReadonlySet<string>>();
    /** B-814: a takeover pass of the persistent outbox in progress. */
    private outboxReclaim: Promise<void> | null = null;
    /** B-814b: rows this tab took over but could not adopt yet (session not loaded, no key, lookup failed) — retried every pass. */
    private outboxDeferred = new Map<string, OutboxRow[]>();
    private outboxReclaimTimer: ReturnType<typeof setInterval> | null = null;
    private sessionMessageLocks = new Map<string, AsyncLock>();
    /** B-803: sessions whose catch-up was skipped while offline; restarted on recovery. */
    private messagesDeferredOffline = new Set<string>();
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private appState: AppStateStatus = AppState.currentState;
    private backgroundSendTimeout: ReturnType<typeof setTimeout> | null = null;
    private backgroundSendNotificationId: string | null = null;
    private backgroundSendStartedAt: number | null = null;


    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.sessionsCatchUpSync = new InvalidateSync(this.catchUpSessionsSinceList);
        this.unarchivedSessionsSync = new InvalidateSync(this.fetchUnarchivedSessions);
        this.syncScheduler = this.createSyncScheduler();
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.purchasesSync = new InvalidateSync(this.syncPurchases);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);

        const registerPushToken = async () => {
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // B-513: a latched account stops every sync loop for good, so nothing
        // would ever flush the outbox again — say so instead of spinning.
        subscribeAuthLatch(() => this.failAllOutbox());

        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            this.appState = nextAppState;

            // Notify server of focus state for push notification routing.
            // Mobile: AppState.currentState reflects fg/bg directly.
            // Web/desktop: visibilitychange/focus listeners below drive this same path
            // by updating this.appState too — re-derive via getCurrentAppState() so
            // the wire value matches what the server uses for suppression.
            apiSocket.sendAppState(getCurrentAppState());

            if (nextAppState === 'active') {
                const shouldFailAfterResume = this.backgroundSendStartedAt !== null
                    && this.hasPendingOutboxMessages()
                    && (Date.now() - this.backgroundSendStartedAt) >= Sync.BACKGROUND_SEND_TIMEOUT_MS;
                void this.cancelBackgroundSendTimeoutNotification();
                this.clearBackgroundSendWatchdog();
                if (shouldFailAfterResume) {
                    void this.notifyMessageSendFailed();
                    this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
                }
                log.log('📱 App became active');
                // Web: the AppState shim flips 'active' on focus too, and the
                // real resume path (visibility edge, below) owns refetching —
                // running this set here as well made one resume fire three
                // refetch fan-outs. Native keeps the full set.
                if (Platform.OS !== 'web') {
                    this.purchasesSync.invalidate();
                    this.profileSync.invalidate();
                    this.machinesSync.invalidate();
                    this.pushTokenSync.invalidate();
                    this.sessionsSync.invalidate();
                    this.nativeUpdateSync.invalidate();
                    log.log('📱 App became active: Invalidating artifacts sync');
                    this.artifactsSync.invalidate();
                    this.friendsSync.invalidate();
                    this.friendRequestsSync.invalidate();
                    this.feedSync.invalidate();
                }
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
                this.maybeStartBackgroundSendWatchdog();
            }
        });

        // Web/desktop: AppState alone doesn't capture tab focus/visibility.
        // Notify server when the tab becomes hidden, regains visibility,
        // or window focus changes — so push routing can suppress only when
        // the user is actually looking at this client. (Focus-aware: that is
        // the push-suppression semantic and stays as is.)
        //
        // The RESUME re-sync is deliberately NOT gated on that focus-aware
        // "active": iOS Safari/PWA returns from background with
        // `document.hasFocus() === false` and no window `focus`, so the old
        // background→active edge never fired and the tab stayed frozen until
        // a manual reload. resumeSync.ts fires on the visibility edge alone
        // (spec `specs/2026-08-web-resume-sync.md` §A) and is the ONLY resume
        // entry on web — the AppState 'active' branch above no longer
        // refetches here. Desktop alt-tab (visibility unchanged) therefore no
        // longer triggers a refetch: intentional, the live socket covers it.
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const broadcast = () => apiSocket.sendAppState(getCurrentAppState());
            document.addEventListener('visibilitychange', broadcast);
            window.addEventListener('focus', broadcast);
            window.addEventListener('blur', broadcast);
            attachResumeListeners({ doc: document, win: window }, () => this.onWebResume());
            this.startNetworkMonitor();
        }
    }

    /**
     * B-799: the app-wide offline judgment (top bar, composer, send deadlines).
     * Started after module init (storage must exist; tests that stub storage
     * without a socket store get no monitor and stay 「online」).
     */
    private startNetworkMonitor() {
        queueMicrotask(() => {
            try {
                if (typeof storage?.getState !== 'function' || typeof storage.subscribe !== 'function') return;
            } catch {
                return; // a test's storage mock without this export
            }
            startNetworkMonitor({
                read: () => {
                    const state = storage.getState();
                    return {
                        browserOnline: isBrowserOnline(),
                        socketConnected: state.socketStatus === 'connected',
                        everConnected: state.socketLastConnectedAt != null,
                        visible: document.visibilityState === 'visible',
                    };
                },
                subscribe: (onChange) => {
                    // B-803b: catch-ups deferred while the browser was offline go out
                    // as soon as it is back (the viewed one also via the resume edge).
                    const onOnline = () => this.restartDeferredCatchUps({ deferredOnly: true });
                    // B-812: offline → subscribed sessions stale(offline); online → hello on a live socket.
                    const onOffline = () => this.syncScheduler.offline();
                    window.addEventListener('online', onOnline);
                    window.addEventListener('offline', onOffline);
                    window.addEventListener('online', onChange);
                    window.addEventListener('offline', onChange);
                    const unsubscribe = storage.subscribe((state, prev) => {
                        if (state.socketStatus !== prev.socketStatus) onChange();
                    });
                    return () => {
                        window.removeEventListener('online', onOnline);
                        window.removeEventListener('offline', onOffline);
                        window.removeEventListener('online', onChange);
                        window.removeEventListener('offline', onChange);
                        unsubscribe();
                    };
                },
                onRecovered: () => {
                    this.flushOutboxesNow();
                    retryWaitingPrompts();
                    this.restartDeferredCatchUps();
                },
            });
        });
    }

    /**
     * B-803: back online — catch-ups skipped while offline (and the viewed
     * session's, which may be stuck in a backoff sleep) go out now.
     */
    private restartDeferredCatchUps(opts?: { deferredOnly?: boolean }) {
        const viewing = opts?.deferredOnly ? null : storage.getState().currentViewingSessionId;
        const ids = new Set(this.messagesDeferredOffline);
        if (viewing) ids.add(viewing);
        this.messagesDeferredOffline.clear();
        for (const sessionId of ids) {
            if (this.syncScheduler.drives(sessionId)) continue; // the scheduler's hello catches it up
            this.restartMessagesSync(sessionId);
        }
        this.syncScheduler.online();
    }

    /** B-799: back online — queued sends go out now, not after the rest of their backoff sleep. */
    private flushOutboxesNow() {
        for (const [sessionId, pending] of this.pendingOutbox) {
            if (pending.length > 0) this.getSendSync(sessionId).invalidateNow();
        }
    }

    /** Subscribe to the web resume edge (terminal screens re-fit + catch up). */
    onResume = (listener: () => void) => {
        this.resumeListeners.add(listener);
        return () => { this.resumeListeners.delete(listener); };
    };

    // Web tab returned to foreground. Three things, all at once and none
    // waiting on the others (spec §A.3):
    //  1. bounded REST refetch that does not depend on the socket at all —
    //     session list (metadata/agentState/permission requests), the viewed
    //     session's messages (forward from lastSeq), machines, artifacts;
    //  2. listeners (terminal catch-up);
    //  3. socket liveness: probe, and force one reconnect if the link is dead
    //     (its `connect` then runs the full onReconnected set).
    // `thinking` is NOT refreshable over REST (fetchSessions writes false and
    // preserveSessionActivityFromStore keeps the local value); it converges
    // from the CLI's 2s keepAlive once the socket is genuinely alive.
    private onWebResume = () => {
        log.log('🌐 Tab resumed from background — re-syncing');
        this.sessionsSync.invalidate();
        // B-812: subscribe mode → one sync-hello (its ack is the liveness proof);
        // legacy / socket down → the REST catch-up (catchUpViewedSession). A REST
        // catch-up still in flight is probably stuck on the dead link (B-803):
        // restarted now in either mode (e2e B3: it waited for the hello hedge).
        this.restartStuckCatchUp();
        this.syncScheduler.resume();
        this.touchViewedSession();
        this.reloadViewedPromptQueue();
        this.machinesSync.invalidate();
        this.artifactsSync.invalidate();
        for (const listener of this.resumeListeners) {
            try { listener(); } catch (e) { log.log(`🌐 resume listener failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
        void apiSocket.checkLiveness();
    };

    async create(credentials: AuthCredentials, encryption: Encryption) {
        // B-262 A3: storage collects yolo-enforcement decisions; execution lives
        // here (storage must not import the RPC layer).
        setPermissionEnforcer((decisions) => runYoloEnforcement(decisions));
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
    }

    async #init() {

        // B-322: the lease must stop the clock while THIS tab's socket is down
        // — a frozen background tab receives no ephemerals because it is not
        // listening, not because the wrapper stopped. Injected rather than
        // imported so heartbeatLease stays free of a storage import cycle.
        setHeartbeatSocketStatusReader(() => storage.getState().socketStatus);

        // B-813: this account's message cache opens while the session list loads.
        void syncCache.open(this.serverID);
        // B-819: …and the session in the URL starts its catch-up with it.
        this.startRoutedCatchUp(globalThis.location?.pathname);

        // Subscribe to updates
        this.subscribeToUpdates();
        this.wirePromptQueueTranscript();

        // Sync initial PostHog opt-out state with stored settings
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // B-818: the UI is ready on the first list, not on sessionsSync's
        // whole queue: a resume or reconnect can queue another full fetch
        // behind it (B-823: the first connect's own catch-up is incremental,
        // catchUpSessionsSinceList), and entering must not wait for that.
        this.firstSessionsList = deferredSignal();
        this.unarchivedSessionsList = deferredSignal();
        this.unarchivedSessionsArrived = deferredSignal();
        const firstListLoaded = this.firstSessionsList.promise;
        const unarchivedListArrived = this.unarchivedSessionsArrived.promise;
        const unarchivedListLoaded = this.unarchivedSessionsList.promise;

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts');

        // Mark UI ready as soon as sessions load. Machines sync may hang
        // when encryption keys are unavailable (e.g. V1 auth fallback) —
        // let it resolve in the background instead of blocking the UI.
        Promise.race([firstListLoaded, this.sessionsSync.awaitQueue()]).then(() => settleWithin(unarchivedListArrived, UNARCHIVED_READY_WAIT_MS)).then(() => settleWithin(unarchivedListLoaded, UNARCHIVED_APPLY_WAIT_MS)).then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load sessions:', error);
            // Still mark ready so the UI doesn't stay on a blank screen forever
            storage.getState().applyReady();
        }).finally(() => {
            // B-814: inputs a closed / reloaded tab left unsent — needs the session list and keys.
            void this.reclaimOutbox();
            this.outboxReclaimTimer ??= setInterval(() => { void this.reclaimOutbox(); }, OUTBOX_RECLAIM_INTERVAL_MS);
        });
    }

    /**
     * B-814 (spec §5.5.3): take over persisted inputs whose tab is gone (this
     * tab's previous load included) — exactly one tab takes each — and send or
     * show them. Runs after the session list loaded, then every
     * OUTBOX_RECLAIM_INTERVAL_MS for tabs closed while this one stays open.
     */
    private reclaimOutbox(): Promise<void> {
        if (this.outboxReclaim) return this.outboxReclaim;
        this.outboxReclaim = (async () => {
            const rows = await outboxStore.takeOver(thisTabId(), isTabAlive, (fn) => withTabLock('vh-outbox-claim', fn));
            // Deferred rows were claimed passes ago: the 10-minute rule counts until now.
            const now = Date.now();
            const bySession = new Map([...this.outboxDeferred].map(([sessionId, deferred]) => [sessionId, deferred.map((row): OutboxRow => ({
                ...row, state: takeoverAction(row, now) === 'resend' ? 'queued' : 'failed',
            }))]));
            this.outboxDeferred.clear();
            // Deferred rows are owned here already: takeOver never returns them twice.
            for (const row of rows) bySession.set(row.sid, [...(bySession.get(row.sid) ?? []), row]);
            for (const [sessionId, sessionRows] of bySession) {
                await this.adoptOutboxRows(sessionId, sessionRows).catch((error) => {
                    log.log(`📨 outbox adoption of ${sessionId} failed (${error instanceof Error ? error.message : String(error)})`);
                    this.outboxDeferred.set(sessionId, [...sessionRows]);
                });
            }
        })().catch((error) => {
            log.log(`📨 outbox takeover failed (${error instanceof Error ? error.message : String(error)})`);
        }).finally(() => { this.outboxReclaim = null; });
        return this.outboxReclaim;
    }

    private async adoptOutboxRows(sessionId: string, rows: readonly OutboxRow[]) {
        if (!storage.getState().sessions[sessionId]) {
            // B-814b: not in the store is not deleted — the list stops at the newest
            // 150 rows, skips rows it cannot decode, and a given-up load leaves it
            // empty. Only a 404 says the session (§5.4.2: and its inputs) is gone.
            const found = await this.fetchSessionById(sessionId).catch(() => null);
            if (found === 'missing') {
                void outboxStore.remove(rows.map((row) => row.localId));
                return;
            }
            if (found === null || !storage.getState().sessions[sessionId]) {
                this.outboxDeferred.set(sessionId, [...rows]);
                return;
            }
        }
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            // Owned here now, so no other pass takes them over: the next one of ours retries.
            this.outboxDeferred.set(sessionId, [...rows]);
            return;
        }
        // The latest page first: a copy the server already stored is then
        // recognised by its localId instead of showing up a second time.
        await settleWithin(this.getMessagesSync(sessionId).invalidateAndAwait(), OUTBOX_ADOPT_PAGE_WAIT_MS);
        // B-815: prompts for the server queue go back to the dock — never out as messages.
        const queueRows = rows.filter(isQueueRow);
        if (queueRows.length > 0) await this.adoptQueueRows(sessionId, queueRows, encryption);
        const messageRows = rows.filter((row) => !isQueueRow(row));
        if (messageRows.length === 0) return;
        const candidates = await Promise.all(messageRows.map(async (row) => ({
            row,
            raw: await encryption.decryptRaw(row.body).catch(() => null) as RawRecord | null,
        })));
        await this.inOutboxOrder(sessionId, () => {
            const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
            const plan = planOutboxAdoption(candidates, {
                tracked: (localId) => this.outboxRecords.has(localId),
                inTranscript: (localId) => reducerState?.localIds.has(localId) === true,
            });
            if (plan.drop.length > 0) void outboxStore.remove(plan.drop);
            for (const { row, raw } of [...plan.resend, ...plan.stale]) {
                this.outboxRecords.set(row.localId, {
                    sessionId,
                    localId: row.localId,
                    content: row.body,
                    group: row.group,
                    order: this.outboxOrder++,
                    // The page that sent it died not knowing — never offered back to the composer.
                    mayHaveStored: true,
                    attemptInFlight: false,
                    raw: raw!,
                });
                const normalized = normalizeRawMessage(row.localId, row.localId, row.createdAt, raw!);
                if (normalized) this.applyOptimistic(sessionId, normalized);
            }
            if (plan.stale.length > 0) {
                storage.getState().applyOutboxResult(sessionId, {
                    failures: plan.stale.map(({ row }) => ({ localId: row.localId, restorable: false, stale: true })),
                });
            }
            if (plan.resend.length > 0) {
                const localIds = plan.resend.map(({ row }) => row.localId);
                log.log(`📨 outbox: re-sending ${localIds.length} input(s) of ${sessionId} left by a closed tab`);
                this.sendDeadlines.start(localIds, Date.now());
                this.ensureSendDeadlineTicker();
                let pending = this.pendingOutbox.get(sessionId);
                if (!pending) {
                    pending = [];
                    this.pendingOutbox.set(sessionId, pending);
                }
                // HTTP only, like a user retry: a restarted wrapper could route a relayed copy twice.
                for (const { row } of plan.resend) pending.push({ localId: row.localId, content: row.body, httpOnly: true });
                this.getSendSync(sessionId).invalidateNow();
            }
        });
    }

    /**
     * B-815: prompts a gone tab left unaccepted by the server queue. One the
     * server already holds (queued, or run: its message is in the latest page)
     * is dropped; the rest re-enter the dock under their localId — fresh ones
     * re-enqueued now (the server dedupes by localId), stale ones failed.
     */
    private async adoptQueueRows(sessionId: string, rows: readonly OutboxRow[], encryption: SessionEncryption) {
        // The server's queue first: a row it accepted (the answer died with the page) is listed there.
        await settleWithin(loadPromptQueue(sessionId), OUTBOX_ADOPT_PAGE_WAIT_MS);
        const candidates = await Promise.all(rows.map(async (row) => ({
            row,
            raw: readOutboundUserRecord(await encryption.decryptRaw(row.body).catch(() => null)),
        })));
        const queue = promptQueueStore.getState().sessions[sessionId];
        const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
        const plan = planOutboxAdoption(candidates, {
            tracked: (localId) => queue?.pending?.some((row) => row.localId === localId) === true,
            inTranscript: (localId) => reducerState?.localIds.has(localId) === true
                || queue?.items.some((item) => item.localId === localId) === true
                || queue?.dispatched?.some((row) => row.localId === localId) === true,
        });
        if (plan.drop.length > 0) void outboxStore.remove(plan.drop);
        const adopted = [...plan.resend.map((c) => ({ c, stale: false })), ...plan.stale.map((c) => ({ c, stale: true }))]
            .map(({ c: { row, raw }, stale }) => ({ localId: row.localId, text: raw!.text, modeMeta: raw!.modeMeta, createdAt: row.createdAt, content: row.body, stale }));
        if (adopted.length > 0) {
            log.log(`📨 outbox: ${plan.resend.length} queued prompt(s) of ${sessionId} left by a closed tab back to the dock (${plan.stale.length} stale)`);
            adoptPendingPrompts(sessionId, adopted);
        }
    }

    /**
     * B-814: mirror inputs that are about to be POSTed into IndexedDB. The
     * POST waits for it (§5.5.2: a send whose page dies before the row is
     * written would leave no trace here), but never longer than
     * OUTBOX_PERSIST_WAIT_MS. Untracked items (tombstones) are not kept.
     */
    private persistOutbox(sessionId: string, items: readonly OutboxMessage[]): Promise<void> {
        const now = Date.now();
        const ownerTabId = thisTabId();
        const rows: OutboxRow[] = [];
        for (const item of items) {
            const record = this.outboxRecords.get(item.localId);
            if (!record || !item.content) continue;
            rows.push({
                localId: item.localId, sid: sessionId, body: item.content, createdAt: now, state: 'queued',
                attempts: 0, ownerTabId, group: record.group, order: record.order,
            });
        }
        if (rows.length === 0) return Promise.resolve();
        return settleWithin(outboxStore.put(rows), OUTBOX_PERSIST_WAIT_MS);
    }

    /**
     * B-801 × B-814: resolves once every input this session's sends handed
     * over so far is encrypted and persisted (or gave up trying) — a pending
     * session's first message leaves its localStorage record only then.
     */
    whenOutboxPersisted(sessionId: string): Promise<void> {
        return this.outboxEncryptChain.get(sessionId) ?? Promise.resolve();
    }


    /**
     * B-805: the user entered this session (screen mount): catch its messages
     * up — the initial page, or forward from lastSeq — then run the session
     * duties (touchViewedSession). Live messages do NOT come through here;
     * they ping `onSessionHeartbeat` and fetch only on a seq gap (sessionMerge.ts).
     */
    onSessionEnter = (sessionId: string) => {
        // B-812: the scheduler subscribes it (subscribe mode) or invalidates the REST sync.
        this.syncScheduler.open(sessionId);
        this.touchViewedSession(sessionId);
    }

    /**
     * B-812 M1: the session-side duties of an enter — warm the machine relay,
     * the yolo alignment (v1 CLIs accept it only while a request is pending, and
     * an agent stuck on one sends no push to trigger it), voice focus. Run on
     * enter and, in EVERY sync mode, when the link comes back (reconnect /
     * recovered / resume) or control returns; the messages catch-up itself is
     * the scheduler's.
     */
    private touchViewedSession(sessionId = storage.getState().currentViewingSessionId) {
        if (!sessionId) return;
        this.onSessionHeartbeat(sessionId);
        const session = storage.getState().sessions[sessionId];
        if (session) voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
    }

    /**
     * B-805: per-incoming-message ping of ANY session — no network fetch. It
     * keeps the machine relay warm and the yolo alignment (self-throttled)
     * current. T-014: there is deliberately NO git-status refresh here either;
     * it fanned 4 `bash` RPCs out to every running agent — 110–170 RPC/min
     * from one idle tab — for a `pathGitStatus` nobody rendered. The Files
     * panel fetches its own git state on open (useSessionFiles).
     */
    private onSessionHeartbeat = (sessionId: string) => {
        const session = storage.getState().sessions[sessionId];
        if (!session) return;
        // B-619: a session shared WITH me has no relay / RPC path — the machine is
        // not this account's; warming its relay only yields diagnostics 422s.
        if (session.metadata?.machineId && !session.share) {
            apiSocket.prepareMachineRelay(session.metadata.machineId);
        }
        if (!session.share) this.alignPermissionModeIfNeeded(sessionId);
    }

    // B-262 A6: upgrade-only alignment. A session the user explicitly put in
    // yolo (this device / synced override) whose CLI has not confirmed bypass
    // gets one set-permission-mode when it is viewed — v2 CLIs accept it idle,
    // v1 only while a request is pending. Never downgrades, never acts on a
    // code-default guess, never while the selector's own RPC is in flight.
    private alignAttemptedAt = new Map<string, number>();
    private alignPermissionModeIfNeeded(sessionId: string) {
        const state = storage.getState();
        const session = state.sessions[sessionId];
        if (!session) return;
        const flavor = session.metadata?.flavor;
        const overrideMode = getAgentDefaultOverride(state.settings.agentDefaultOverrides, flavor).permissionMode;
        const published = session.metadata?.permissionMode;
        const displayed = session.permissionMode ?? overrideMode ?? getCodeAgentDefaults(flavor).permissionMode;
        const intentSource = resolveIntentSource({ published, local: session.permissionMode, override: overrideMode });
        const requests = session.agentState?.requests ?? {};
        const should = shouldAlignToBypass({
            flavor,
            controlledByUser: session.agentState?.controlledByUser,
            presence: session.presence,
            displayed,
            intentSource,
            published,
            capabilities: session.metadata?.capabilities,
            hasPendingRequests: Object.keys(requests).length > 0,
            busy: state.permissionModeBusy[sessionId] === true,
        });
        if (!should) return;
        const last = this.alignAttemptedAt.get(sessionId) ?? 0;
        if (Date.now() - last < 30_000) return;
        this.alignAttemptedAt.set(sessionId, Date.now());
        apiSocket.sessionRPC(sessionId, 'set-permission-mode', { mode: 'bypassPermissions' }, { timeoutMs: 20_000 })
            .then(() => log.log(`🔐 yolo alignment applied for ${sessionId}`))
            .catch((error) => log.log(`🔐 yolo alignment skipped for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`));
    }

    /**
     * B-804: legacy resume / retry / online — the viewed session's messages are
     * re-read (anything sent into the dead link is gone for good), and the
     * catch-up is shown while it takes a while. The session duties are the
     * caller's (touchViewedSession, B-812 M1).
     */
    private catchUpViewedSession() {
        const viewing = storage.getState().currentViewingSessionId;
        if (!viewing) return;
        // B-803: a catch-up still in flight is probably stuck on the dead link — abort it, go again now.
        this.restartMessagesSync(viewing);
        this.trackMessagesCatchUp(viewing);
    }

    /** B-804: resume / reconnect / recovered / retry — the prompt queue is re-read whatever path the messages take. */
    private reloadViewedPromptQueue() {
        const viewing = storage.getState().currentViewingSessionId;
        if (viewing) void reloadPromptQueue(viewing);
    }

    /** B-804: show the viewed session's pending messages catch-up (top bar + chat line, after 300ms). */
    private trackMessagesCatchUp(sessionId: string) {
        if (storage.getState().currentViewingSessionId !== sessionId) return;
        trackCatchUp(sessionId, this.getMessagesSync(sessionId).awaitQueue());
    }

    /**
     * B-804: 「连接不稳定 · 重试」 — abort the stuck attempt and go again now
     * (B-803 restart), and probe the socket. B-803b: a socket that is not
     * connected gets a fresh connect attempt instead (the probe would leave
     * the manager's possibly dead attempt alone).
     */
    retryMessagesCatchUp = (sessionId: string) => {
        void reloadPromptQueue(sessionId);
        // B-812: subscribe mode on a live socket — generation + 1, hello now.
        if (this.syncScheduler.retry(sessionId)) return;
        // QA7 O-1: the restarted read must not wait HEDGE_AFTER_MS on a dead pooled connection first.
        armHedgeBurst();
        this.restartMessagesSync(sessionId);
        this.trackMessagesCatchUp(sessionId);
        if (!apiSocket.reconnectIfDown()) void apiSocket.checkLiveness();
    };

    /**
     * B-804: the dock's hand-off rows (promptQueue.ts) look the localId up in
     * the transcript; a row the transcript never gets is dropped once a fetch
     * started after the hand-off has finished without it.
     */
    private wirePromptQueueTranscript() {
        promptQueueTranscript.has = (sessionId, localId) => storage.getState().sessionMessages[sessionId]?.reducerState.localIds.has(localId) === true;
        promptQueueTranscript.verify = (sessionId, localIds) => {
            // B-812: over the socket when the scheduler drives the session.
            const viaSocket = this.syncScheduler.catchUp(sessionId);
            if (viaSocket) {
                void viaSocket.then(() => settleDispatchedPrompts(sessionId, localIds));
                return;
            }
            const messages = this.getMessagesSync(sessionId);
            messages.invalidate();
            void messages.awaitQueue().then(() => settleDispatchedPrompts(sessionId, localIds));
        };
    }

    private getMessagesSync(sessionId: string): InvalidateSync {
        let sync = this.messagesSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync((signal) => this.fetchMessages(sessionId, signal));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private getSendSync(sessionId: string): InvalidateSync {
        let sync = this.sendSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.flushOutbox(sessionId));
            this.sendSync.set(sessionId, sync);
        }
        return sync;
    }

    /**
     * B-513: an optimistic input is reduced synchronously, marked `sending`.
     * It must not queue behind the per-session lock — `fetchMessages` holds
     * that across a network round trip, which is what made a send appear
     * seconds late. The reducer is synchronous, so this cannot interleave with
     * another apply; a single optimistic item keeps arrival order (铁律 15).
     */
    private applyOptimistic(sessionId: string, message: NormalizedMessage) {
        this.writeMessagesToStore(sessionId, [message], message.localId ? [message.localId] : undefined);
    }

    /** B-812: a local-only record (no server seq, e.g. a send-failure notice) — not a merge source. */
    private applyLocalMessages(sessionId: string, messages: NormalizedMessage[]) {
        if (messages.length > 0) this.writeMessagesToStore(sessionId, messages);
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    private hasPendingOutboxMessages() {
        if (this.sendAbortControllers.size > 0) {
            return true;
        }
        for (const messages of this.pendingOutbox.values()) {
            if (messages.length > 0) {
                return true;
            }
        }
        return false;
    }

    private maybeStartBackgroundSendWatchdog() {
        if (Platform.OS === 'web' || this.appState === 'active') {
            return;
        }
        if (!this.hasPendingOutboxMessages() || this.backgroundSendTimeout) {
            return;
        }

        log.log('📨 Pending messages detected in background. Starting 30s send watchdog.');
        this.backgroundSendStartedAt = Date.now();
        this.backgroundSendTimeout = setTimeout(() => {
            this.backgroundSendTimeout = null;
            void this.handleBackgroundSendTimeout();
        }, Sync.BACKGROUND_SEND_TIMEOUT_MS);
        void this.scheduleBackgroundSendTimeoutNotification();
    }

    private clearBackgroundSendWatchdog() {
        if (this.backgroundSendTimeout) {
            clearTimeout(this.backgroundSendTimeout);
            this.backgroundSendTimeout = null;
        }
        this.backgroundSendStartedAt = null;
    }

    private async scheduleBackgroundSendTimeoutNotification() {
        if (Platform.OS === 'web' || this.backgroundSendNotificationId) {
            return;
        }
        try {
            this.backgroundSendNotificationId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message not sent',
                    body: 'A message is still sending in the background. It will fail in 30 seconds if not delivered.',
                    sound: true
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                    seconds: Math.ceil(Sync.BACKGROUND_SEND_TIMEOUT_MS / 1000)
                }
            });
        } catch (error) {
            log.log(`Failed to schedule background send timeout notification: ${error}`);
        }
    }

    private async cancelBackgroundSendTimeoutNotification() {
        if (!this.backgroundSendNotificationId) {
            return;
        }
        try {
            await Notifications.cancelScheduledNotificationAsync(this.backgroundSendNotificationId);
        } catch (error) {
            log.log(`Failed to cancel background send timeout notification: ${error}`);
        } finally {
            this.backgroundSendNotificationId = null;
        }
    }

    private async notifyMessageSendFailed() {
        if (Platform.OS === 'web') {
            return;
        }
        try {
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: 'Message failed',
                    body: 'A message failed to send while the app was in background. Open Happy and retry.',
                    sound: true
                },
                trigger: null
            });
        } catch (error) {
            log.log(`Failed to schedule message failure notification: ${error}`);
        }
    }

    private failPendingOutboxMessages(reasonText: string) {
        const sessionIds = this.failAllOutbox();
        const now = Date.now();

        for (const sessionId of sessionIds) {
            this.applyLocalMessages(sessionId, [{
                id: randomUUID(),
                localId: null,
                createdAt: now,
                role: 'event',
                isSidechain: false,
                content: {
                    type: 'message',
                    message: reasonText
                }
            }]);
        }
    }

    /**
     * B-825: every input the server has not confirmed — what an auth-expiry
     * wipe would delete: this tab's (queued or failed, oldest first; text from
     * the plain record kept for retries) and the persistent outbox rows no tab
     * has adopted yet (a page closed before it could send them; with a dead
     * token this load never gets to adopt them). Their text is shown only when
     * the session key is already loaded; attachments have none.
     */
    async unsentOutboxMessages(): Promise<UnsentMessage[]> {
        const unsent: UnsentMessage[] = [...this.outboxRecords.values()]
            .sort((a, b) => a.order - b.order)
            .map((record) => ({
                sessionId: record.sessionId,
                localId: record.localId,
                text: readOutboundUserRecord(record.raw)?.text ?? null,
            }));
        const rows = await outboxStore.all().catch(() => [] as OutboxRow[]);
        const untracked = rows
            .filter((row) => !this.outboxRecords.has(row.localId))
            .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
        for (const row of untracked) {
            const encryption = this.encryption?.getSessionEncryption(row.sid);
            const raw = encryption ? await encryption.decryptRaw(row.body).catch(() => null) : null;
            unsent.push({ sessionId: row.sid, localId: row.localId, text: readOutboundUserRecord(raw)?.text ?? null });
        }
        return unsent;
    }

    /** Abort every in-flight send and fail everything still queued. Returns the affected sessions. */
    private failAllOutbox(): string[] {
        for (const controller of this.sendAbortControllers.values()) {
            controller.abort();
        }
        this.sendAbortControllers.clear();
        const sessionIds: string[] = [];
        for (const [sessionId, pending] of [...this.pendingOutbox]) {
            if (pending.length === 0) continue;
            this.failOutboxItems(sessionId, pending.map((item) => item.localId));
            this.pendingOutbox.delete(sessionId);
            sessionIds.push(sessionId);
        }
        return sessionIds;
    }

    /**
     * B-513: the single per-message fail path (deadline, non-retryable answer,
     * auth latch, native background watchdog). Removes the items from the
     * queue by localId and shows tracked ones as failed. Invisible items (queue
     * tombstones) are just dropped.
     */
    private failOutboxItems(sessionId: string, localIds: readonly string[]) {
        if (localIds.length === 0) return;
        const pending = this.pendingOutbox.get(sessionId);
        if (pending) {
            removeByLocalId(pending, new Set(localIds));
            if (pending.length === 0) this.pendingOutbox.delete(sessionId);
        }
        const failures: { localId: string; restorable: boolean }[] = [];
        for (const localId of localIds) {
            this.sendDeadlines.delete(localId);
            const record = this.outboxRecords.get(localId);
            if (!record) continue;
            const groupSize = [...this.outboxRecords.values()].filter((other) => other.group === record.group).length;
            failures.push({
                localId,
                // Only text can go back into the composer (attachments are
                // released after sending), and only if nothing could have
                // stored it — otherwise a re-send would duplicate it.
                restorable: groupSize === 1 && !record.mayHaveStored && !record.attemptInFlight,
            });
        }
        if (failures.length > 0) {
            storage.getState().applyOutboxResult(sessionId, { failures });
            void outboxStore.update(failures.map((failure) => failure.localId), (row) => ({ ...row, state: 'failed' }));
        }
    }

    private trackOutboxItems(sessionId: string, localIds: readonly string[], contents: readonly string[], group: string, raws?: readonly RawRecord[]) {
        localIds.forEach((localId, index) => {
            this.outboxRecords.set(localId, {
                sessionId,
                localId,
                content: contents[index],
                group,
                order: this.outboxOrder++,
                mayHaveStored: false,
                attemptInFlight: false,
                ...(raws?.[index] ? { raw: raws[index] } : {}),
            });
        });
        this.sendDeadlines.start(localIds, Date.now());
        this.ensureSendDeadlineTicker();
    }

    /**
     * B-722: run `step` after every earlier outbox step of this session, so
     * items reach `pendingOutbox` in the order they were shown even though
     * each one is encrypted after it appeared.
     */
    private inOutboxOrder(sessionId: string, step: () => Promise<void> | void): Promise<void> {
        const previous = this.outboxEncryptChain.get(sessionId) ?? Promise.resolve();
        const run = previous.then(step);
        const tail = run.catch(() => {});
        this.outboxEncryptChain.set(sessionId, tail);
        void tail.then(() => {
            if (this.outboxEncryptChain.get(sessionId) === tail) this.outboxEncryptChain.delete(sessionId);
        });
        return run;
    }

    /**
     * B-722: encrypt items that are already on screen (marked `sending`) and
     * hand them to the outbox. A failed encryption fails them visibly (they
     * never left, so they stay restorable); an item withdrawn or failed by its
     * deadline meanwhile keeps its encrypted content for Retry but is not sent.
     */
    private encryptIntoOutbox(
        sessionId: string,
        encryption: { encryptRawRecord: (record: RawRecord) => Promise<string> },
        items: readonly { localId: string; raw: RawRecord }[],
        options?: { httpOnly?: boolean },
    ): Promise<void> {
        return this.inOutboxOrder(sessionId, async () => {
            let encrypted: string[];
            try {
                encrypted = await Promise.all(items.map((item) => encryption.encryptRawRecord(item.raw)));
            } catch (error) {
                log.log(`📨 encrypting a send for ${sessionId} failed (${error instanceof Error ? error.message : String(error)})`);
                this.failOutboxItems(sessionId, items.map((item) => item.localId));
                return;
            }
            const ready: OutboxMessage[] = [];
            items.forEach((item, index) => {
                const record = this.outboxRecords.get(item.localId);
                if (!record) return;
                record.content = encrypted[index];
                if (this.sendDeadlines.has(item.localId)) {
                    ready.push({ localId: item.localId, content: encrypted[index], ...(options?.httpOnly ? { httpOnly: true } : {}) });
                }
            });
            if (ready.length === 0) return;
            await this.persistOutbox(sessionId, ready);
            // Its deadline (or a withdraw) may have ended it while the row was written.
            const live = ready.filter((item) => this.sendDeadlines.has(item.localId));
            if (live.length === 0) return;
            let pending = this.pendingOutbox.get(sessionId);
            if (!pending) {
                pending = [];
                this.pendingOutbox.set(sessionId, pending);
            }
            pending.push(...live);
            this.getSendSync(sessionId).invalidateNow();
            this.maybeStartBackgroundSendWatchdog();
        });
    }

    /** B-513 review: drop retry records the reducer has confirmed (e.g. an echo after a deadline failure). */
    private pruneOutboxRecords(sessionId: string) {
        const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
        if (!reducerState) return;
        const pending = this.pendingOutbox.get(sessionId) ?? [];
        const settled = settledOutboxRecords(this.outboxRecords.values(), sessionId, reducerState.sendStates,
            (localId) => this.sendDeadlines.has(localId) || pending.some((item) => item.localId === localId));
        for (const localId of settled) this.outboxRecords.delete(localId);
        if (settled.length > 0) void outboxStore.remove(settled);
    }

    private ensureSendDeadlineTicker() {
        if (this.sendDeadlineTimer || this.sendDeadlines.size === 0) return;
        this.sendDeadlineTimer = setInterval(this.tickSendDeadlines, SEND_DEADLINE_TICK_MS);
    }

    private tickSendDeadlines = () => {
        // B-799: the budget also pauses while the app judges the device offline
        // (socket gone for SOCKET_OFFLINE_AFTER_MS with navigator.onLine still
        // true — captive Wi-Fi, a dead uplink): the send waits, it does not fail.
        const expired = this.sendDeadlines.tick(Date.now(), isBrowserOnline() && !isNetworkOffline());
        const bySession = new Map<string, string[]>();
        for (const localId of expired) {
            const sessionId = this.outboxRecords.get(localId)?.sessionId;
            if (!sessionId) continue;
            bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), localId]);
        }
        for (const [sessionId, localIds] of bySession) {
            // Fail first (the in-flight attempt still counts as maybe-stored),
            // then abort the request that carries them.
            this.failOutboxItems(sessionId, localIds);
            const inFlight = this.inFlightOutbox.get(sessionId);
            if (inFlight && localIds.some((localId) => inFlight.has(localId))) {
                this.sendAbortControllers.get(sessionId)?.abort();
            }
        }
        if (this.sendDeadlines.size === 0 && this.sendDeadlineTimer) {
            clearInterval(this.sendDeadlineTimer);
            this.sendDeadlineTimer = null;
        }
    };

    /**
     * B-513: re-send a failed input — with the SAME localId(s), so a copy the
     * server did store is deduplicated — together with every failed item of
     * the same user turn (attachments + text) in their original order. HTTP only.
     */
    retrySend(sessionId: string, localId: string): boolean {
        const record = this.outboxRecords.get(localId);
        const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
        if (!record || record.sessionId !== sessionId || !reducerState) return false;
        const members = [...this.outboxRecords.values()]
            .filter((other) => other.group === record.group && reducerState.sendStates.get(other.localId) === 'failed')
            .sort((a, b) => a.order - b.order);
        if (members.length === 0) return false;
        const localIds = members.map((member) => member.localId);
        // B-814: the user's retry restarts the 10-minute clock; the row is the outbox's again.
        const retriedAt = Date.now();
        // A row the first send never got onto disk (persist timed out) is written now.
        const ownerTabId = thisTabId();
        const byLocalId = new Map(members.map((member) => [member.localId, member]));
        void outboxStore.update(localIds, (row) => ({ ...row, state: 'queued', createdAt: retriedAt, attempts: row.attempts + 1, ownerTabId }), (id) => {
            const member = byLocalId.get(id);
            return member?.content ? {
                localId: id, sid: sessionId, body: member.content, createdAt: retriedAt, state: 'queued',
                attempts: 1, ownerTabId, group: member.group, order: member.order,
            } : null;
        });
        if (members.some((member) => !member.content)) {
            // B-722: its encryption failed — encrypt again, then send as usual.
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption || members.some((member) => !member.raw)) return false;
            storage.getState().applyOutboxResult(sessionId, { sending: localIds });
            this.sendDeadlines.start(localIds, Date.now());
            this.ensureSendDeadlineTicker();
            void this.encryptIntoOutbox(sessionId, encryption, members.map((member) => ({ localId: member.localId, raw: member.raw! })), { httpOnly: true });
            return true;
        }
        let pending = this.pendingOutbox.get(sessionId);
        if (!pending) {
            pending = [];
            this.pendingOutbox.set(sessionId, pending);
        }
        removeByLocalId(pending, new Set(localIds));
        for (const member of members) {
            pending.push({ localId: member.localId, content: member.content, httpOnly: true });
        }
        storage.getState().applyOutboxResult(sessionId, { sending: localIds });
        this.sendDeadlines.start(localIds, Date.now());
        this.ensureSendDeadlineTicker();
        // The fresh 15s budget must not be spent sleeping off an old backoff.
        this.getSendSync(sessionId).invalidateNow();
        return true;
    }

    /**
     * B-513: take a failed text message back for the composer. Only when
     * `sendRestorable` (no attempt could have stored it); the row disappears
     * but the localId stays known, so a late echo would bring it back.
     * Returns the text, or null when not allowed.
     */
    takeBackFailedMessage(sessionId: string, localId: string): string | null {
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        const message = sessionMessages?.messages.find((m) => m.kind === 'user-text' && m.localId === localId);
        if (!message || message.kind !== 'user-text' || message.sendState !== 'failed' || !message.sendRestorable) return null;
        storage.getState().applyOutboxResult(sessionId, { withdraw: [localId] });
        this.outboxRecords.delete(localId);
        void outboxStore.remove([localId]);
        return message.text;
    }

    /**
     * B-814: 「丢弃」 on an input restored from an earlier page load — the whole
     * failed turn leaves this device. It may still have reached the server
     * (that page died not knowing); then its echo brings it back, like a
     * taken-back message's would.
     */
    discardStaleMessage(sessionId: string, localId: string): boolean {
        const record = this.outboxRecords.get(localId);
        const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
        if (!record || record.sessionId !== sessionId || !reducerState) return false;
        const localIds = [...this.outboxRecords.values()]
            .filter((other) => other.group === record.group && reducerState.sendStates.get(other.localId) === 'failed')
            .map((member) => member.localId);
        if (localIds.length === 0) return false;
        storage.getState().applyOutboxResult(sessionId, { withdraw: localIds });
        for (const id of localIds) this.outboxRecords.delete(id);
        void outboxStore.remove(localIds);
        return true;
    }

    private async handleBackgroundSendTimeout() {
        if (!this.hasPendingOutboxMessages()) {
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
            return;
        }

        await this.cancelBackgroundSendTimeoutNotification();
        await this.notifyMessageSendFailed();
        this.failPendingOutboxMessages('Message failed to send in background after 30s. Please retry.');
        this.backgroundSendStartedAt = null;
    }

    /**
     * Download + decrypt one attachment the user sent earlier (B-355).
     *
     * The blob key is derived PER SESSION (`getSessionBlobKey`), which is why
     * callers must cache by `sessionId + ref` and never by `ref` alone.
     * Returns null instead of throwing: a missing attachment thumbnail degrades
     * to the plain file row, it never breaks the transcript.
     */
    async downloadAttachment(sessionId: string, ref: string): Promise<Uint8Array | null> {
        if (!this.credentials) return null;
        const blobKey = this.encryption.getSessionBlobKey(sessionId);
        if (!blobKey) {
            console.error(`[attachments] No blob key for session ${sessionId}`);
            return null;
        }
        try {
            const encrypted = await downloadEncryptedAttachment(this.credentials, sessionId, ref);
            const decrypted = decryptBlob(encrypted, blobKey);
            if (!decrypted) console.error(`[attachments] Failed to decrypt ${ref}`);
            return decrypted;
        } catch (error) {
            // keep the reason visible: a 401 and a network failure look the same
            // from the UI, and both used to be silent.
            console.error(`[attachments] Download failed for ${ref}:`, error);
            return null;
        }
    }

    /**
     * Upload file attachments for a session: read bytes → encrypt → upload to server.
     * Returns UploadedAttachment records to embed as file events before the text message.
     * Failures are logged and skipped rather than aborting the whole message send.
     */
    private async uploadAttachmentsForSession(
        sessionId: string,
        attachments: AttachmentPreview[],
    ): Promise<{ uploaded: UploadedAttachment[]; failed: number }> {
        if (!this.credentials) return { uploaded: [], failed: attachments.length };

        const blobKey = this.encryption.getSessionBlobKey(sessionId);
        if (!blobKey) {
            console.error(`[attachments] No blob key for session ${sessionId}`);
            return { uploaded: [], failed: attachments.length };
        }

        // B-513: up to 3 PUTs in parallel; results keep the picked order and a
        // failed file is skipped without aborting the others.
        const results = await mapWithConcurrency(attachments, ATTACHMENT_UPLOAD_CONCURRENCY, async (attachment): Promise<UploadedAttachment | null> => {
            try {
                const bytes = await readFileBytes(attachment.uri);
                const encrypted = encryptBlob(bytes, blobKey);

                const upload = await requestAttachmentUpload(
                    this.credentials,
                    sessionId,
                    attachment.name,
                    encrypted.length,
                );

                await uploadEncryptedBlob(upload, encrypted, this.credentials!);
                const { ref } = upload;

                return {
                    ref,
                    name: attachment.name,
                    size: attachment.size,
                    mimeType: attachment.mimeType,
                    width: attachment.width,
                    height: attachment.height,
                    thumbhash: attachment.thumbhash,
                };
            } catch (err) {
                console.error(`[attachments] Failed to upload ${attachment.name}:`, err);
                // Skip this attachment; do not abort the whole message send.
                return null;
            }
        });

        const uploaded = results.filter((result): result is UploadedAttachment => result !== null);
        return { uploaded, failed: results.length - uploaded.length };
    }

    /** B-509: encrypt the exact user record a typed prompt would carry, for the server-side prompt queue. */
    async encryptQueuedPrompt(sessionId: string, text: string, modeMeta: MessageModeMeta): Promise<string | null> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) return null;
        return encryption.encryptRawRecord(buildOutboundUserRecord({ text, sentFrom: resolveSentFrom(), appendSystemPrompt: systemPrompt, modeMeta }));
    }

    /** B-509: decrypt a queued prompt record for display / editing. */
    async decryptQueuedPrompt(sessionId: string, encrypted: string): Promise<unknown | null> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) return null;
        return encryption.decryptRaw(encrypted);
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions) {
        // Realtime sidebar ordering, layer 1: "I just talked to this session".
        // Stamped at ENTRY, before the encryption/session awaits below — the
        // row must float the instant the user hits send, not a round-trip
        // later, and the durable `updatedAt` catches up on its own. Covers
        // every composer (chat input, option picker, new-session first
        // message, voice) because they all funnel through here.
        // Note this means a send that FAILS below (session not found) still
        // floats the row. That's deliberate: the user did just act on it, and
        // the alternative is a sluggish list on the happy path.
        stampLocalActivity(activityKeyForSession(sessionId));

        // Get encryption — may not be ready yet if sessions are still syncing
        let encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            // Wait for sessions sync to complete (initializes encryption keys)
            await this.sessionsSync.awaitQueue();
            encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                console.error(`Session ${sessionId} not found after sync`);
                return;
            }
        }

        // Get session data from storage
        let session = storage.getState().sessions[sessionId];
        if (!session) {
            await this.sessionsSync.awaitQueue();
            session = storage.getState().sessions[sessionId];
            if (!session) {
                console.error(`Session ${sessionId} not found in storage after sync`);
                return;
            }
        }

        const modeMeta = options?.modeMeta ?? resolveMessageModeMeta(session, storage.getState().settings);
        const { source = 'chat', delivery = 'queue', attachments } = options ?? {};
        // B-642: an attached `<edited_drafts>` block is for the model only —
        // every client (old ones included) shows the user's own text.
        const displayText = options?.displayText ?? (hasEditedDraftsBlock(text) ? (stripEditedDrafts(text) || undefined) : undefined);
        // Question/permission answers have their own request/response path and
        // must not wait behind the ordinary chat queue. For normal input, keep
        // sending durably right away but tell the Web that the current turn has
        // not consumed it yet. Old CLIs safely strip this optional meta field.
        // B-295: a `running` tool call that lost its wrapper never closes, so
        // it may only mean "the turn hasn't consumed this yet" while the
        // session is genuinely working (sync/agentLiveness.ts). Otherwise every
        // message sent after one restart was stamped queued forever.
        // B-322: `hasRunningTool` was dead code. It was gated on `agentLive`,
        // and `agentLive` already implies `thinking === true`, so
        // `thinking || hasRunningTool` could never differ from `thinking` — it
        // just re-scanned the whole transcript on every send. B-295 patched the
        // gate on without re-deriving the invariant. Stamping now goes through
        // the SAME liveness judgement as everything else, lease included:
        // otherwise a latched `thinking` keeps painting messages as queued
        // forever, which is exactly what this batch is fixing elsewhere.
        const agentLive = isAgentWorkLive({
            presence: session.presence,
            thinking: session.thinking,
            runningSubagentsInTurn: 0,
            heartbeatFresh: isHeartbeatFresh(sessionId),
        });
        const queuedAt = delivery === 'steer'
            ? undefined
            : queuedAtForSend(agentLive, source);

        // New runners advertise attachment consumption; old wrappers remain gated.
        const supportsAttachments = supportsSessionAttachments(session.metadata);
        const effectiveAttachments = supportsAttachments ? attachments : undefined;

        if (attachments && attachments.length > 0 && !supportsAttachments) {
            Modal.alert(
                t('imageUpload.notSupportedTitle'),
                t('imageUpload.notSupportedMessage'),
                [{ text: t('common.ok'), style: 'cancel' }],
            );
            if (text.trim().length === 0) {
                throw new Error('This session does not support attachments');
            }
        }

        // B-513: one user turn = one retry group (attachments + text).
        // Items enter the outbox together, after every record is encrypted: a
        // flush running during an await must never see a half-built turn.
        // Each item is tracked (record + deadline) BEFORE it is shown, so one
        // that never reaches the outbox (a later throw) still fails visibly.
        const group = randomUUID();
        const turnItems: OutboxMessage[] = [];
        const localId = options?.localId ?? randomUUID();
        // B-814: this exact input is already ours (a pending session's first
        // message re-sent after a reload that also restored it from the
        // persistent outbox) — never a second bubble; a failed one is retried.
        if (options?.localId && this.outboxRecords.get(localId)?.sessionId === sessionId) {
            if (storage.getState().sessionMessages[sessionId]?.reducerState.sendStates.get(localId) === 'failed') this.retrySend(sessionId, localId);
            return localId;
        }
        // Create user message content with metadata (B-509: one builder shared
        // with the server-side prompt queue, so a queued prompt is the same record).
        const content: RawRecord = buildOutboundUserRecord({
            text,
            sentFrom: resolveSentFrom(),
            appendSystemPrompt: systemPrompt,
            modeMeta,
            delivery,
            displayText,
            queuedAt,
        });

        // B-722: a text-only turn is shown in the click stack — encryption
        // (async WebCrypto) used to sit between the click and the bubble. It is
        // tracked before it is shown, encrypted after, and enters the outbox in
        // send order (encryptIntoOutbox); a failed encryption shows as failed.
        if (!effectiveAttachments || effectiveAttachments.length === 0) {
            const normalizedText = normalizeRawMessage(localId, localId, Date.now(), content);
            this.trackOutboxItems(sessionId, [localId], [''], group, [content]);
            if (normalizedText) this.applyOptimistic(sessionId, normalizedText);
            trackMessageSent(source, session.metadata);
            void this.encryptIntoOutbox(sessionId, encryption, [{ localId, raw: content }]);
            return localId; // Receipt: accepted into the local outbox, not server delivery.
        }

        // Upload attachments and queue file events before the text message.
        if (effectiveAttachments && effectiveAttachments.length > 0) {
            const { uploaded, failed } = await this.uploadAttachmentsForSession(sessionId, effectiveAttachments);

            if (failed > 0) {
                Modal.alert(
                    t('imageUpload.uploadFailedTitle'),
                    t('imageUpload.uploadFailedMessage', { count: failed }),
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
            }

            if (uploaded.length === 0 && text.trim().length === 0) {
                throw new Error('All attachments failed to upload');
            }

            if (uploaded.length > 0) {

                for (const att of uploaded) {
                    const fileRecord: RawRecord = {
                        role: 'session',
                        ...(queuedAt !== undefined ? { meta: { queuedAt } } : {}),
                        content: {
                            type: 'session',
                            data: {
                                id: randomUUID(),
                                time: Date.now(),
                                role: 'user',
                                ev: {
                                    t: 'file',
                                    ref: att.ref,
                                    name: att.name,
                                    size: att.size,
                                    mimeType: att.mimeType,
                                    // Include image metadata when we have dimensions; thumbhash is
                                    // optional. The native iOS picker can't generate a thumbhash
                                    // without Canvas, so requiring it here would reduce the chat
                                    // bubble to a compact filename row instead of an inline picture.
                                    // FileView only needs w/h to size the inline render — placeholder
                                    // is absent, but the real image is decrypted on mount.
                                    ...(att.width > 0 && att.height > 0
                                        ? {
                                            image: {
                                                width: att.width,
                                                height: att.height,
                                                ...(att.thumbhash ? { thumbhash: att.thumbhash } : {}),
                                            },
                                        }
                                        : {}),
                                },
                            },
                        },
                    };
                    const encryptedFileRecord = await encryption.encryptRawRecord(fileRecord);
                    const fileLocalId = randomUUID();
                    const fileNormalized = normalizeRawMessage(fileLocalId, fileLocalId, Date.now(), fileRecord);
                    this.trackOutboxItems(sessionId, [fileLocalId], [encryptedFileRecord], group);
                    if (fileNormalized) {
                        this.applyOptimistic(sessionId, fileNormalized);
                    }
                    turnItems.push({ localId: fileLocalId, content: encryptedFileRecord });
                }
            }
        }

        const encryptedRawRecord = await encryption.encryptRawRecord(content);

        // Add to messages - normalize the raw record
        const createdAt = Date.now();
        const normalizedMessage = normalizeRawMessage(localId, localId, createdAt, content);
        this.trackOutboxItems(sessionId, [localId], [encryptedRawRecord], group);
        if (normalizedMessage) {
            this.applyOptimistic(sessionId, normalizedMessage);
        }
        turnItems.push({ localId, content: encryptedRawRecord });
        trackMessageSent(source, session.metadata);

        // The whole turn enters the outbox at once, behind any text-only turn
        // shown earlier that is still being encrypted (B-722).
        void this.inOutboxOrder(sessionId, async () => {
            await this.persistOutbox(sessionId, turnItems);
            let pending = this.pendingOutbox.get(sessionId);
            if (!pending) {
                pending = [];
                this.pendingOutbox.set(sessionId, pending);
            }
            pending.push(...turnItems);
            this.getSendSync(sessionId).invalidateNow();
            this.maybeStartBackgroundSendWatchdog();
        });
        return localId; // Receipt: accepted into the local outbox, not server delivery.
    }

    /** Persist an invisible queue-cancel tombstone after the CLI removed it. */
    async recordQueueCancellation(sessionId: string, targetLocalKeys: string[]): Promise<void> {
        if (targetLocalKeys.length === 0) throw new Error('Session encryption unavailable');
        await this.recordUserSessionEvent(sessionId, { t: 'queue-cancel', targetLocalKeys });
    }

    /**
     * B-528: hide [fromSeq, toSeq) after the agent rewound its conversation
     * (in-place edit / delete). `toSeq` omitted = up to this tombstone.
     */
    async recordTranscriptDrop(sessionId: string, drop: { fromSeq: number; toSeq?: number; reason: 'edit' | 'delete'; requestId?: string }): Promise<void> {
        await this.recordUserSessionEvent(sessionId, {
            t: 'transcript-drop',
            fromSeq: drop.fromSeq,
            ...(typeof drop.toSeq === 'number' ? { toSeq: drop.toSeq } : {}),
            reason: drop.reason,
            // B-544: confirms the wrapper's provisional rewind.
            ...(drop.requestId ? { requestId: drop.requestId } : {}),
        });
    }

    private async recordUserSessionEvent(sessionId: string, ev: SessionEventPayload): Promise<void> {
        let encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            await this.sessionsSync.awaitQueue();
            encryption = this.encryption.getSessionEncryption(sessionId);
        }
        if (!encryption) {
            throw new Error('Session encryption unavailable');
        }

        const localId = randomUUID();
        const now = Date.now();
        const content: RawRecord = {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: randomUUID(),
                    time: now,
                    role: 'user',
                    ev,
                },
            },
        };
        const encrypted = await encryption.encryptRawRecord(content);
        const normalized = normalizeRawMessage(localId, localId, now, content);
        if (normalized) this.applyLocalMessages(sessionId, [normalized]);
        let pending = this.pendingOutbox.get(sessionId);
        if (!pending) {
            pending = [];
            this.pendingOutbox.set(sessionId, pending);
        }
        pending.push({ localId, content: encrypted });
        this.getSendSync(sessionId).invalidateNow();
        this.maybeStartBackgroundSendWatchdog();
    }

    /** Server sent us settings — merge any pending local changes on top, then apply as one update. */
    private applyServerSettings = (serverSettings: Settings, version: number) => {
        const merged = Object.keys(this.pendingSettings).length > 0
            ? applySettings(serverSettings, this.pendingSettings)
            : serverSettings;
        storage.getState().applySettings(merged, version);

        // One-time migration (B-052): fold legacy terminalCommands into
        // promptPresets (run:true). Both fields go out in ONE settings delta
        // (field-level LWW updates them together); idempotent — once
        // terminalCommands is empty this returns null forever, and a stale
        // non-empty copy arriving later (old device / LWW race) re-migrates
        // with same-text dedup instead of duplicating.
        const migration = migrateTerminalCommands(merged.promptPresets, merged.terminalCommands);
        if (migration) this.applySettings(migration);

        // B-262 A1: a dead selector key (dontAsk) persisted in the synced
        // per-agent override would be sent with every message and make the
        // CLI drop it. Rewrite once, as the FULL overrides object (铁律 1).
        const sanitizedOverrides = sanitizeAgentDefaultOverrides(merged.agentDefaultOverrides);
        if (sanitizedOverrides) this.applySettings({ agentDefaultOverrides: sanitizedOverrides });
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);

        // Sync PostHog opt-out state if it was changed
        if (tracking && 'analyticsOptOut' in delta) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate settings sync
        this.settingsSync.invalidate();
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    async assumeUsers(userIds: string[]): Promise<void> {
        if (!this.credentials || userIds.length === 0) return;
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;
        
        log.log(`👤 Fetching ${missingIds.length} missing users...`);
        
        // Fetch missing users in parallel
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(this.credentials!, id);
                    return { id, profile };  // profile is null if 404
                } catch (error) {
                    console.error(`Failed to fetch user ${id}:`, error);
                    return { id, profile: null };  // Treat errors as 404
                }
            })
        );
        
        // Convert to Record<string, UserProfile | null>
        const usersMap: Record<string, UserProfile | null> = {};
        results.forEach(({ id, profile }) => {
            usersMap[id] = profile;
        });
        
        storage.getState().applyUsers(usersMap);
        log.log(`👤 Applied ${results.length} users to cache (${results.filter(r => r.profile).length} found, ${results.filter(r => !r.profile).length} not found)`);
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        // B-803: bounded — a list GET stuck on a dead link must not hold
        // sessionsSync (and every resume/reconnect refresh coalesced behind it).
        // B-803b: hedged like the message pages (hedgedRead.ts).
        const token = this.credentials.token;
        // B-823: the boot prefetch (main.tsx) is this read's first attempt.
        const prefetched = takeSessionListPrefetch(token);
        const { data, date } = await hedgedRead(async (signal, pool, index): Promise<SessionListResponse> => {
            if (index === 0 && prefetched) return adoptSessionListPrefetch(prefetched, signal, pool.onResponse);
            const request = sessionListRequest(API_ENDPOINT, token);
            const response = await fetchWithDeadline(fetch, request.url, {
                headers: request.headers,
                timeoutMs: SYNC_READ_TIMEOUT_MS,
                signal,
                ...pool,
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch sessions: ${response.status}`);
            }

            return { data: await response.json(), date: response.headers.get('date') };
        });
        const sessions = (data as { sessions: unknown }).sessions as Array<{
            id: string;
            tag: string;
            seq: number;
            metadata: string;
            metadataVersion: number;
            agentState: string | null;
            agentStateVersion: number;
            dataEncryptionKey: string | null;
            active: boolean;
            activeAt: number;
            archivedAt?: number | null;
            createdAt: number;
            updatedAt: number;
            lastMessage: ApiMessage | null;
            /** B-619: only on rows shared WITH this account. */
            share?: SessionShareInfo;
        }>;

        // Key init + metadata/agentState decryption (one bad row is skipped,
        // never wedging the batch) — shared with the new-session update (B-512).
        const decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] =
            await decodeSessionRows(this.encryption, sessions);

        // Take exactly one current snapshot immediately before the synchronous
        // apply. Reading inside the decrypt loop can resurrect an activity
        // state that a later realtime event already ended.
        const mergedSessions = preserveSessionBatchActivityFromStore(
            decryptedSessions,
            storage.getState().sessions,
        );
        this.applySessions(mergedSessions);
        this.sessionListSnapshot = sessionListSnapshot(sessions, parseServedAt(date));
        log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} sessions`);
        this.firstSessionsList.resolve();
        // Owner 10-27: the list above is the 150 newest rows; once per load, read every unarchived one.
        if (!this.unarchivedSessionsList.settled) this.unarchivedSessionsSync.invalidate();

    }

    /**
     * Owner 10-27 (「侧边栏的会话会突然变少，然后再加载回完整的 list」): the
     * first list is the 150 newest rows, and on a big account live sessions
     * fall outside them (the Owner's window held 38 of 381 unarchived rows), so
     * every fresh load started short and filled in as updates trickled. Once
     * per load, after that list, every unarchived row (`scope=unarchived`,
     * ≤500, running first) is read and merged — never replacing anything. Not
     * on resume / reconnect: those lists stay the window, and rows already
     * here stay (the store only merges).
     */
    private fetchUnarchivedSessions = async () => {
        if (!this.credentials || this.unarchivedSessionsList.settled) return;
        const token = this.credentials.token;
        const request = sessionListRequest(getServerUrl(), token, 'unarchived');
        const data = await hedgedRead(async (signal, pool) => {
            const response = await fetchWithDeadline(fetch, request.url, {
                headers: request.headers,
                timeoutMs: SYNC_READ_TIMEOUT_MS,
                signal,
                ...pool,
            });
            if (!response.ok) throw new Error(`Failed to fetch unarchived sessions: ${response.status}`);
            return await response.json() as { sessions?: Array<EncryptedSessionRow & { archivedAt?: number | null; share?: SessionShareInfo }> };
        });
        if (!this.credentials || this.credentials.token !== token) return;
        const rows = data.sessions ?? [];
        this.unarchivedSessionsArrived.resolve();
        // Rows the first list already brought at the same versions are not decoded again; the
        // rest decode in chunks (the window renders between them) and merge once — every
        // store write re-renders the whole sidebar.
        const fresh = rowsToDecode(rows, storage.getState().sessions);
        const decoded = await decodeInChunks(fresh, (chunk) => decodeSessionRows(this.encryption, chunk));
        if (!this.credentials || this.credentials.token !== token) return;
        if (decoded.length > 0) this.applySessions(preserveSessionBatchActivityFromStore(decoded, storage.getState().sessions));
        if (this.sessionListSnapshot) this.sessionListSnapshot = mergeSessionListSnapshot(this.sessionListSnapshot, rows);
        log.log(`📥 unarchived sessions: ${rows.length} rows, ${fresh.length} applied`);
        this.unarchivedSessionsList.resolve();
    }

    /**
     * B-823: the first connect's catch-up (sessionListDelta.ts). Runs after
     * the first full list; any doubt (no baseline, a failed read, too many
     * changes) falls back to that full list.
     */
    private catchUpSessionsSinceList = async () => {
        if (!this.credentials) return;
        await this.sessionsSync.awaitQueue();
        await catchUpSessionList({
            snapshot: this.sessionListSnapshot,
            listChanged: (changedSince) => this.readChangedSessions(changedSince),
            readRows: (ids) => this.readSessionRows(ids),
            apply: async (rows) => {
                const decoded = await decodeSessionRows(this.encryption, rows);
                this.applySessions(preserveSessionBatchActivityFromStore(decoded, storage.getState().sessions));
            },
            fullList: () => this.sessionsSync.invalidate(),
            log: (line) => log.log(line),
        });
    }

    /** B-823: one page of the account's rows changed since `changedSince` (ids + updatedAt only are used). */
    private async readChangedSessions(changedSince: number): Promise<{ rows: Array<{ id: string; updatedAt: number }>; hasNext: boolean }> {
        const response = await fetchWithDeadline(fetch, `${getServerUrl()}/v2/sessions?changedSince=${changedSince}&limit=${DELTA_PAGE_LIMIT}`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'X-Happy-Client': getHappyClientId(),
            },
            timeoutMs: SYNC_READ_TIMEOUT_MS,
            ...hedgePoolInit(0),
        });
        if (!response.ok) throw new Error(`Failed to list changed sessions: ${response.status}`);
        const data = await response.json() as { sessions?: Array<{ id: string; updatedAt: number }>; hasNext?: boolean };
        return { rows: data.sessions ?? [], hasNext: data.hasNext === true };
    }

    /** B-823: the list projection of a few sessions by id; a 404 (gone, unshared) is skipped. */
    private async readSessionRows(ids: readonly string[]): Promise<Array<EncryptedSessionRow & { archivedAt?: number | null; share?: SessionShareInfo }>> {
        const rows: Array<EncryptedSessionRow & { archivedAt?: number | null; share?: SessionShareInfo }> = [];
        const queue = [...ids];
        const worker = async () => {
            for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
                const response = await fetchWithDeadline(fetch, `${getServerUrl()}/v1/sessions/${encodeURIComponent(id)}`, {
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'X-Happy-Client': getHappyClientId(),
                    },
                    timeoutMs: SYNC_READ_TIMEOUT_MS,
                    ...hedgePoolInit(0),
                });
                if (response.status === 404) continue;
                if (!response.ok) throw new Error(`Failed to fetch session: ${response.status}`);
                rows.push((await response.json() as { session: EncryptedSessionRow & { archivedAt?: number | null; share?: SessionShareInfo } }).session);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
        return rows;
    }

    /**
     * B-798 P1-8: one session by id. The list above stops at the newest 150
     * rows (and the once-per-load unarchived read skips archived ones), so a
     * link to an older archived (or unknown) session never reached the store
     * and the page spun forever. 404 = not this account's (nor shared with it).
     */
    public fetchSessionById = async (sessionId: string): Promise<'found' | 'missing'> => {
        if (!this.credentials) throw new Error('Not signed in');
        const response = await fetch(`${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'X-Happy-Client': getHappyClientId(),
            }
        });
        if (response.status === 404) return 'missing';
        if (!response.ok) throw new Error(`Failed to fetch session: ${response.status}`);
        // Same projection as a /v1/sessions row (archivedAt, share ride along).
        const data = await response.json() as { session: EncryptedSessionRow & { archivedAt?: number | null; share?: SessionShareInfo } };
        const decoded = await decodeSessionRows(this.encryption, [data.session]);
        if (decoded.length === 0) throw new Error('Session could not be decoded');
        this.applySessions(preserveSessionBatchActivityFromStore(decoded, storage.getState().sessions));
        return 'found';
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    /** B-621: People screen / share picker after a friend action (the socket event also lands, this is the no-wait path). */
    public refreshFriends = async () => {
        return this.friendsSync.invalidateAndAwait();
    }

    /**
     * Purge a deleted session from local state. Called from the
     * `delete-session` socket update AND directly after a successful
     * DELETE request — the HTTP response must not depend on the socket
     * echo arriving (it may be disconnected), and purging immediately
     * tombstones the id so raced updates can't resurrect the session.
     * Idempotent, so running it from both paths is fine.
     */
    public onSessionDeleted = (sessionId: string) => {
        // Remove session from storage (also records the deletion tombstone)
        storage.getState().deleteSession(sessionId);

        // Remove encryption keys from memory
        this.encryption.removeSessionEncryption(sessionId);
        // B-554: its diff-comment drafts can never be sent anywhere now
        clearDiffCommentDrafts(sessionId);

        this.messagesSync.delete(sessionId);
        forgetCatchUp(sessionId);
        this.sendSync.delete(sessionId);
        this.pendingOutbox.delete(sessionId);
        this.outboxDeferred.delete(sessionId);
        // B-513: send states die with the reducer state deleteSession dropped;
        // drop the retry records and deadlines too.
        this.sendAbortControllers.get(sessionId)?.abort();
        for (const [localId, record] of [...this.outboxRecords]) {
            if (record.sessionId !== sessionId) continue;
            this.outboxRecords.delete(localId);
            this.sendDeadlines.delete(localId);
        }
        this.cursors.delete(sessionId);
        const reorderTimer = this.reorderTimers.get(sessionId);
        if (reorderTimer) clearTimeout(reorderTimer);
        this.reorderTimers.delete(sessionId);
        this.syncScheduler.forget(sessionId);
        syncCache.dropSession(sessionId, 'deleted');
        this.unverifiedCacheHits.delete(sessionId);
        this.cachePrefetch.delete(sessionId);
        this.cacheProbes.get(sessionId)?.controller.abort();
        this.cacheProbes.delete(sessionId);
        this.messagesAwaitingKeys.delete(sessionId);
        this.sessionMessageLocks.delete(sessionId);
        this.messagesDeferredOffline.delete(sessionId);

        log.log(`🗑️ Session ${sessionId} deleted from local storage`);
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        log.log('📦 fetchArtifactsList: Starting artifact sync');
        if (!this.credentials) {
            log.log('📦 fetchArtifactsList: No credentials, skipping');
            return;
        }

        try {
            log.log('📦 fetchArtifactsList: Fetching artifacts from server');
            const artifacts = await fetchArtifacts(this.credentials);
            log.log(`📦 fetchArtifactsList: Received ${artifacts.length} artifacts from server`);
            const decryptedArtifacts: DecryptedArtifact[] = [];

            for (const artifact of artifacts) {
                try {
                    // Decrypt the data encryption key
                    const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        console.error(`Failed to decrypt key for artifact ${artifact.id}`);
                        continue;
                    }

                    // Store the decrypted key in memory
                    this.artifactDataKeys.set(artifact.id, decryptedKey);

                    // Create artifact encryption instance
                    const artifactEncryption = new ArtifactEncryption(decryptedKey);

                    // Decrypt header
                    const header = await artifactEncryption.decryptHeader(artifact.header);
                    
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: header?.title || null,
                        sessions: header?.sessions,  // Include sessions from header
                        draft: header?.draft,        // Include draft flag from header
                        body: undefined, // Body not loaded in list
                        headerVersion: artifact.headerVersion,
                        bodyVersion: artifact.bodyVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: !!header,
                    });
                } catch (err) {
                    console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
                    // Add with decryption failed flag
                    decryptedArtifacts.push({
                        id: artifact.id,
                        title: null,
                        body: undefined,
                        headerVersion: artifact.headerVersion,
                        seq: artifact.seq,
                        createdAt: artifact.createdAt,
                        updatedAt: artifact.updatedAt,
                        isDecrypted: false,
                    });
                }
            }

            log.log(`📦 fetchArtifactsList: Successfully decrypted ${decryptedArtifacts.length} artifacts`);
            storage.getState().applyArtifacts(decryptedArtifacts);
            log.log('📦 fetchArtifactsList: Artifacts applied to storage');
        } catch (error) {
            log.log(`📦 fetchArtifactsList: Error fetching artifacts: ${error}`);
            console.error('Failed to fetch artifacts:', error);
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        try {
            const artifact = await fetchArtifact(this.credentials, artifactId);

            // Decrypt the data encryption key
            const decryptedKey = await this.encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
            if (!decryptedKey) {
                console.error(`Failed to decrypt key for artifact ${artifactId}`);
                return null;
            }

            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifact.id, decryptedKey);

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(decryptedKey);

            // Decrypt header and body
            const header = await artifactEncryption.decryptHeader(artifact.header);
            const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

            return {
                id: artifact.id,
                title: header?.title || null,
                sessions: header?.sessions,  // Include sessions from header
                draft: header?.draft,        // Include draft flag from header
                body: body?.body || null,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: !!header,
            };
        } catch (error) {
            console.error(`Failed to fetch artifact ${artifactId}:`, error);
            return null;
        }
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Generate unique artifact ID
            const artifactId = this.encryption.generateId();

            // Generate data encryption key
            const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
            
            // Store the decrypted key in memory
            this.artifactDataKeys.set(artifactId, dataEncryptionKey);
            
            // Encrypt the data encryption key with user's key
            const encryptedKey = await this.encryption.encryptEncryptionKey(dataEncryptionKey);
            
            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
            
            // Encrypt header and body
            const encryptedHeader = await artifactEncryption.encryptHeader({ title, sessions, draft });
            const encryptedBody = await artifactEncryption.encryptBody({ body });
            
            // Create the request
            const request: ArtifactCreateRequest = {
                id: artifactId,
                header: encryptedHeader,
                body: encryptedBody,
                dataEncryptionKey: encodeBase64(encryptedKey, 'base64'),
            };
            
            // Send to server
            const artifact = await createArtifact(this.credentials, request);
            
            // Add to local storage
            const decryptedArtifact: DecryptedArtifact = {
                id: artifact.id,
                title,
                sessions,
                draft,
                body,
                headerVersion: artifact.headerVersion,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt,
                isDecrypted: true,
            };
            
            storage.getState().addArtifact(decryptedArtifact);
            
            return artifactId;
        } catch (error) {
            console.error('Failed to create artifact:', error);
            throw error;
        }
    }

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: string | null,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        try {
            // Get current artifact to get versions and encryption key
            const currentArtifact = storage.getState().artifacts[artifactId];
            if (!currentArtifact) {
                throw new Error('Artifact not found');
            }

            // Get the data encryption key from memory or fetch it
            let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
            
            // Fetch full artifact if we don't have version info or encryption key
            let headerVersion = currentArtifact.headerVersion;
            let bodyVersion = currentArtifact.bodyVersion;
            
            if (headerVersion === undefined || bodyVersion === undefined || !dataEncryptionKey) {
                const fullArtifact = await fetchArtifact(this.credentials, artifactId);
                headerVersion = fullArtifact.headerVersion;
                bodyVersion = fullArtifact.bodyVersion;
                
                // Decrypt and store the data encryption key if we don't have it
                if (!dataEncryptionKey) {
                    const decryptedKey = await this.encryption.decryptEncryptionKey(fullArtifact.dataEncryptionKey);
                    if (!decryptedKey) {
                        throw new Error('Failed to decrypt encryption key');
                    }
                    this.artifactDataKeys.set(artifactId, decryptedKey);
                    dataEncryptionKey = decryptedKey;
                }
            }

            // Create artifact encryption instance
            const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

            // Prepare update request
            const updateRequest: ArtifactUpdateRequest = {};
            
            // Check if header needs updating (title, sessions, or draft changed)
            if (title !== currentArtifact.title || 
                JSON.stringify(sessions) !== JSON.stringify(currentArtifact.sessions) ||
                draft !== currentArtifact.draft) {
                const encryptedHeader = await artifactEncryption.encryptHeader({ 
                    title, 
                    sessions, 
                    draft 
                });
                updateRequest.header = encryptedHeader;
                updateRequest.expectedHeaderVersion = headerVersion;
            }

            // Only update body if it changed
            if (body !== currentArtifact.body) {
                const encryptedBody = await artifactEncryption.encryptBody({ body });
                updateRequest.body = encryptedBody;
                updateRequest.expectedBodyVersion = bodyVersion;
            }

            // Skip if no changes
            if (Object.keys(updateRequest).length === 0) {
                return;
            }

            // Send update to server
            const response = await updateArtifact(this.credentials, artifactId, updateRequest);
            
            if (!response.success) {
                // Handle version mismatch
                if (response.error === 'version-mismatch') {
                    throw new Error('Artifact was modified by another client. Please refresh and try again.');
                }
                throw new Error('Failed to update artifact');
            }

            // Update local storage
            const updatedArtifact: DecryptedArtifact = {
                ...currentArtifact,
                title,
                sessions,
                draft,
                body,
                headerVersion: response.headerVersion !== undefined ? response.headerVersion : headerVersion,
                bodyVersion: response.bodyVersion !== undefined ? response.bodyVersion : bodyVersion,
                updatedAt: Date.now(),
            };
            
            storage.getState().updateArtifact(updatedArtifact);
        } catch (error) {
            console.error('Failed to update artifact:', error);
            throw error;
        }
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        console.log('📊 Sync: Fetching machines...');
        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/machines`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch machines: ${response.status}`);
            return;
        }

        const data = await response.json();
        console.log(`📊 Sync: Fetched ${Array.isArray(data) ? data.length : 0} machines from server`);
        const machines = data as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
        }>;

        // First, collect and decrypt encryption keys for all machines.
        //
        // Resilience: a single machine whose data key cannot be decrypted
        // (legacy/foreign key format, contentKeyPair mismatch, malformed
        // base64) must NOT abort the whole sync. Previously a throw here
        // rejected fetchMachines entirely — backoff() only console.warn's and
        // retries forever, so applyMachines was never reached and EVERY
        // machine silently vanished from the store (empty /new, no
        // console.error). On failure we fall back to a null key: the machine
        // still gets a (legacy) encryptor and stays visible/selectable, just
        // with undecryptable metadata.
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                let decryptedKey: Uint8Array | null = null;
                try {
                    decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                } catch (error) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}:`, error);
                }
                if (decryptedKey) {
                    machineKeysMap.set(machine.id, decryptedKey);
                    this.machineDataKeys.set(machine.id, decryptedKey);
                } else {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id} - keeping machine with undecryptable metadata`);
                    machineKeysMap.set(machine.id, null);
                }
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions. Guard so an init failure cannot
        // reject the whole sync and wipe the machine list.
        try {
            await this.encryption.initializeMachines(machineKeysMap);
        } catch (error) {
            console.error('Failed to initialize machine encryptions:', error);
        }

        // Process all machines first, then update state once. Every machine is
        // pushed exactly once — decryption failures degrade to null metadata
        // instead of dropping the machine, so a machine never disappears from
        // the picker just because its metadata could not be read.
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            try {
                const machineEncryption = this.encryption.getMachineEncryption(machine.id);

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machineEncryption && machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machineEncryption && machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error(`Failed to decrypt machine ${machine.id}:`, error);
                // Still add the machine with null metadata so it stays visible.
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // Replace entire machine state with fetched machines — but never wipe
        // a populated store with an empty result. An empty list here almost
        // always means a transient fetch/decrypt problem, not "user has no
        // machines"; destroying good state would blank /new until restart.
        const existingMachineCount = Object.keys(storage.getState().machines).length;
        if (decryptedMachines.length === 0 && existingMachineCount > 0) {
            log.log(`🖥️ fetchMachines: empty result, keeping ${existingMachineCount} existing machine(s)`);
            return;
        }
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        
        try {
            log.log('👥 Fetching friends list...');
            const friendsList = await getFriendsList(this.credentials);
            storage.getState().applyFriends(friendsList);
            log.log(`👥 fetchFriends completed - processed ${friendsList.length} friends`);
        } catch (error) {
            console.error('Failed to fetch friends:', error);
            // Silently handle error - UI will show appropriate state
        }
    }

    private fetchFriendRequests = async () => {
        // Friend requests are now included in the friends list with status='pending'
        // This method is kept for backward compatibility but does nothing
        log.log('👥 fetchFriendRequests called - now handled by fetchFriends');
    }

    private fetchFeed = async () => {
        if (!this.credentials) return;

        try {
            log.log('📰 Fetching feed...');
            const state = storage.getState();
            const existingItems = state.feedItems;
            const head = state.feedHead;
            
            // Load feed items - if we have a head, load newer items
            let allItems: FeedItem[] = [];
            let hasMore = true;
            let cursor = head ? { after: head } : undefined;
            let loadedCount = 0;
            const maxItems = 500;
            
            // Keep loading until we reach known items or hit max limit
            while (hasMore && loadedCount < maxItems) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100,
                    ...cursor
                });
                
                // Check if we reached known items
                const foundKnown = response.items.some(item => 
                    existingItems.some(existing => existing.id === item.id)
                );
                
                allItems.push(...response.items);
                loadedCount += response.items.length;
                hasMore = response.hasMore && !foundKnown;
                
                // Update cursor for next page
                if (response.items.length > 0) {
                    const lastItem = response.items[response.items.length - 1];
                    cursor = { after: lastItem.cursor };
                }
            }
            
            // If this is initial load (no head), also load older items
            if (!head && allItems.length < 100) {
                const response = await fetchFeed(this.credentials, {
                    limit: 100
                });
                allItems.push(...response.items);
            }
            
            // Collect user IDs from friend-related feed items
            const userIds = new Set<string>();
            allItems.forEach(item => {
                if (item.body && (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted')) {
                    userIds.add(item.body.uid);
                }
            });
            
            // Fetch missing users
            if (userIds.size > 0) {
                await this.assumeUsers(Array.from(userIds));
            }
            
            // Filter out items where user is not found (404)
            const users = storage.getState().users;
            const compatibleItems = allItems.filter(item => {
                // Keep text items
                if (item.body.kind === 'text') return true;
                
                // For friend-related items, check if user exists and is not null (404)
                if (item.body.kind === 'friend_request' || item.body.kind === 'friend_accepted') {
                    const userProfile = users[item.body.uid];
                    // Keep item only if user exists and is not null
                    return userProfile !== null && userProfile !== undefined;
                }
                
                return true;
            });
            
            // Apply only compatible items to storage
            storage.getState().applyFeedItems(compatibleItems);
            log.log(`📰 fetchFeed completed - loaded ${compatibleItems.length} compatible items (${allItems.length - compatibleItems.length} filtered)`);
        } catch (error) {
            console.error('Failed to fetch feed:', error);
        }
    }

    private syncSettings = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const maxRetries = 3;
        let retryCount = 0;

        // Apply pending settings
        if (Object.keys(this.pendingSettings).length > 0) {

            while (retryCount < maxRetries) {
                // Snapshot what we're about to send so we can detect concurrent changes
                const sentPending = { ...this.pendingSettings };
                let version = storage.getState().settingsVersion;
                let settings = applySettings(storage.getState().settings, this.pendingSettings);
                const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
                    method: 'POST',
                    body: JSON.stringify({
                        settings: await this.encryption.encryptRaw(settingsToSyncPayload(settings)),
                        expectedVersion: version ?? 0
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': getHappyClientId(),
                    }
                });
                const data = await response.json() as {
                    success: false,
                    error: string,
                    currentVersion: number,
                    currentSettings: string | null
                } | {
                    success: true
                };
                if (data.success) {
                    // Only clear keys we actually sent — preserve any settings
                    // added by applySettings() calls during the POST roundtrip
                    const newPending: Partial<Settings> = {};
                    for (const key of Object.keys(this.pendingSettings) as (keyof Settings)[]) {
                        if (!(key in sentPending) || this.pendingSettings[key] !== sentPending[key]) {
                            (newPending as any)[key] = this.pendingSettings[key];
                        }
                    }
                    this.pendingSettings = newPending;
                    savePendingSettings(this.pendingSettings);
                    break;
                }
                if (data.error === 'version-mismatch') {
                    // Parse server settings
                    const serverSettings = data.currentSettings
                        ? settingsParse(await this.encryption.decryptRaw(data.currentSettings))
                        : { ...settingsDefaults };

                    // Merge: server base + our pending changes (our changes win)
                    const mergedSettings = applySettings(serverSettings, this.pendingSettings);

                    // Update local storage with merged result at server's version
                    this.applyServerSettings(mergedSettings, data.currentVersion);

                    // Sync tracking state with merged settings
                    if (tracking) {
                        mergedSettings.analyticsOptOut ? tracking.optOut() : tracking.optIn();
                    }

                    // Log and retry
                    console.log('settings version-mismatch, retrying', {
                        serverVersion: data.currentVersion,
                        retry: retryCount + 1,
                        pendingKeys: Object.keys(this.pendingSettings)
                    });
                    retryCount++;
                    continue;
                } else {
                    throw new Error(`Failed to sync settings: ${data.error}`);
                }
            }
        }

        // If exhausted retries, throw to trigger outer backoff delay
        if (retryCount >= maxRetries) {
            throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
        }

        // Run request
        const response = await fetch(`${API_ENDPOINT}/v1/account/settings`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch settings: ${response.status}`);
        }
        const data = await response.json() as {
            settings: string | null,
            settingsVersion: number
        };

        // Parse response
        let parsedSettings: Settings;
        if (data.settings) {
            parsedSettings = settingsParse(await this.encryption.decryptRaw(data.settings));
        } else {
            parsedSettings = { ...settingsDefaults };
        }

        // Apply settings to storage, re-layering any pending local changes on top
        this.applyServerSettings(parsedSettings, data.settingsVersion);

        // Sync PostHog opt-out state with settings
        if (tracking) {
            if (parsedSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const API_ENDPOINT = getServerUrl();
        const response = await fetch(`${API_ENDPOINT}/v1/account/profile`, {
            headers: {
                'Authorization': `Bearer ${this.credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch profile: ${response.status}`);
        }

        const data = await response.json();
        const parsedProfile = profileParse(data);

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Happy-Client': getHappyClientId(),
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

            if (!response.ok) {
                console.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const data = await response.json();
            console.log('[fetchNativeUpdate] Data:', data);

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            console.log('[fetchNativeUpdate] Error:', error);
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    // B-823: web has no store purchases — appConfig never carries a RevenueCat
    // key, so the SDK (789KB, on the startup path) only ever reached its
    // 「no API key」 return. Purchases stay empty; the sync loop is kept so
    // native-shaped callers (create, refreshPurchases) need no special case.
    private syncPurchases = async () => {};

    private flushOutbox = async (sessionId: string) => {
        const pending = this.pendingOutbox.get(sessionId);
        if (!pending || pending.length === 0) {
            if (!this.hasPendingOutboxMessages()) {
                this.clearBackgroundSendWatchdog();
                await this.cancelBackgroundSendTimeoutNotification();
                this.backgroundSendStartedAt = null;
            }
            return;
        }

        const batch = pending.slice();
        const batchIds = new Set(batch.map((message) => message.localId));
        const records = batch
            .map((message) => this.outboxRecords.get(message.localId))
            .filter((record): record is OutboxRecord => !!record);
        const controller = new AbortController();
        this.sendAbortControllers.set(sessionId, controller);
        this.inFlightOutbox.set(sessionId, batchIds);
        const markDispatched = () => {
            for (const record of records) record.attemptInFlight = true;
        };
        let data: V3PostSessionMessagesResponse;
        let attempt = beginSendAttempt(isBrowserOnline);
        try {
            const session = storage.getState().sessions[sessionId];
            const machineId = session?.metadata?.machineId;
            const relayResult = machineId && !batch.some((message) => message.httpOnly)
                ? await apiSocket.deliverSessionMessages(machineId, sessionId, batch.map(({ localId, content }) => ({ localId, content })), { onEmit: markDispatched })
                : null;
            if (relayResult?.messages) {
                data = { messages: relayResult.messages };
            } else {
                if (controller.signal.aborted) throw new DOMException('Send deadline reached', 'AbortError');
                // A relay attempt that got no ack may still have stored it.
                for (const record of records) {
                    if (record.attemptInFlight) record.mayHaveStored = true;
                }
                markDispatched();
                // Judge a later network error by the state the request LEFT in.
                attempt = beginSendAttempt(isBrowserOnline);
                const response = await apiSocket.request(`/v3/sessions/${sessionId}/messages`, {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: batch.map((message) => ({
                            localId: message.localId,
                            content: message.content
                        }))
                    }),
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal
                });
                await assertResponseOk(response, `Failed to send messages for ${sessionId}`);
                data = await response.json() as V3PostSessionMessagesResponse;
            }
        } catch (error) {
            const outcome = attempt.classify(error);
            for (const record of records) {
                if (outcome.mayHaveStored && record.attemptInFlight) record.mayHaveStored = true;
                record.attemptInFlight = false;
            }
            if (outcome.kind !== 'retry') {
                // Final answer from the server: retrying the same batch is
                // pointless. Show it as failed instead of spinning forever.
                log.log(`📨 send to ${sessionId} rejected (${error instanceof Error ? error.message : String(error)})`);
                this.failOutboxItems(sessionId, [...batchIds].filter((localId) => pending.some((message) => message.localId === localId)));
                return;
            }
            this.maybeStartBackgroundSendWatchdog();
            throw error;
        } finally {
            for (const record of records) record.attemptInFlight = false;
            this.sendAbortControllers.delete(sessionId);
            this.inFlightOutbox.delete(sessionId);
        }

        const outcome = interpretSendResponse(
            Array.isArray(data.messages) ? data.messages : [],
            batchIds,
            new Set(records.map((record) => record.localId)),
        );
        // Remove exactly what the server acknowledged, by localId.
        removeByLocalId(pending, outcome.ackedIds);
        for (const ack of outcome.acks) {
            this.outboxRecords.delete(ack.localId);
            this.sendDeadlines.delete(ack.localId);
        }
        // B-814 §5.5.2: confirmed — the ack's seq is merged just below, so `sent` ends here.
        if (outcome.acks.length > 0) void outboxStore.remove(outcome.acks.map((ack) => ack.localId));
        if (outcome.acks.length > 0 || outcome.untracked.length > 0) {
            storage.getState().applyOutboxResult(sessionId, { acks: outcome.acks, stored: outcome.untracked });
            markSendConfirmed(outcome.acks.map((ack) => ack.localId));
        }
        // B-513: our acks prove only our seqs — a point source (contiguous run; a hole waits the reorder window).
        if (outcome.lastSeqCandidates.length > 0) {
            this.mergeSessionMessages(sessionId, outcome.lastSeqCandidates.map((seq) => ({ seq, message: null })), 'send-ack');
        }

        // Only drop the queue this request drained: a deadline may have removed
        // it meanwhile and a new send created a fresh one under the same key.
        if (pending.length === 0 && this.pendingOutbox.get(sessionId) === pending) {
            this.pendingOutbox.delete(sessionId);
        }
        if (!this.hasPendingOutboxMessages()) {
            this.clearBackgroundSendWatchdog();
            await this.cancelBackgroundSendTimeoutNotification();
            this.backgroundSendStartedAt = null;
        } else if (this.appState !== 'active') {
            this.maybeStartBackgroundSendWatchdog();
        }
    }

    private fetchMessages = async (sessionId: string, signal: AbortSignal = new AbortController().signal) => {
        // B-803: the browser itself offline → no catch-up at all: every
        // attempt would only fail and back off. The `online` event, the
        // network monitor's onRecovered and the socket reconnect restart it.
        // B-803b: NOT the socket-down half of the B-799 judgment — REST often
        // works while the socket is still stuck reconnecting (8s after a
        // resume the bar says 「离线」, and the catch-up waited for the socket).
        if (!isBrowserOnline()) {
            log.log(`💬 fetchMessages: offline, deferring ${sessionId} until the network is back`);
            this.messagesDeferredOffline.add(sessionId);
            return;
        }
        this.messagesDeferredOffline.delete(sessionId);
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (encryption) this.messagesAwaitingKeys.delete(sessionId);
        if (!encryption) {
            // B-813: no key before the session list lands — read the cached run meanwhile.
            if (this.lastSeqOf(sessionId) === undefined && !this.cachePrefetch.has(sessionId) && syncCache.mayHave(sessionId)) {
                // Off the critical path (the key is not here yet): it may wait for the database to open.
                const load = syncCache.load(sessionId, { viewed: this.isViewed(sessionId), openWaitMs: OPEN_BLOCKED_MS });
                const prefetch = { load, settled: false };
                this.cachePrefetch.set(sessionId, prefetch);
                // B-819: and its anchor probe, alongside the session list.
                void load.then((hit) => {
                    prefetch.settled = true;
                    if (hit && this.cachePrefetch.get(sessionId) === prefetch) this.startCacheProbe(sessionId, hit);
                }, () => { prefetch.settled = true; });
            }
            this.messagesAwaitingKeys.add(sessionId);
            log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
            throw new Error(`Session encryption not ready for ${sessionId}`);
        }

        // B-803: no lock here. Requests and decryption run outside the
        // session message lock; only the merge takes it (messageCatchUp.ts).
        const knownLastSeq = this.lastSeqOf(sessionId);
        const isInitialLoad = knownLastSeq === undefined;
        if (isInitialLoad) {
            // Initial load. Pull only the most recent page (extended to
            // the newest turn's opener, bounded) so the user can start
            // chatting immediately. Older history is fetched one page at
            // a time through loadOlderMessages() when the reader parks the
            // top of the loaded history in view or presses 「加载更早」 —
            // B-616: there is deliberately NO background loop filling the
            // history in (sync/historyWindow.ts).
            // B-805: live updates from here on join the buffer the page drains.
            this.cursor(sessionId).anchorRequested = true;
            // B-813: a cached run renders now; the catch-up then checks it
            // against the server and extends it. Any doubt → the cold path.
            // B-819: the check's request is already out (or goes out now) while
            // the run decrypts and renders — not one round trip after it.
            const hit = await this.readCachedRun(sessionId);
            let caughtUp = false;
            if (hit) {
                const probe = this.takeCacheProbe(sessionId, hit, signal);
                let rendered: CacheRender | null = null;
                try {
                    rendered = await this.applyCachedMessages(sessionId, encryption, hit, signal, () => probe.answer ?? null);
                } finally {
                    if (!rendered) probe.controller.abort();
                }
                if (rendered?.merged) {
                    // The probe answered while the run decrypted: checked and merged in that one commit.
                    const lastSeq = this.lastSeqOf(sessionId) ?? hit.lastSeq;
                    if (rendered.merged.hasMore) {
                        const forward = this.fetchForwardSince(sessionId, encryption, lastSeq, signal);
                        if (storage.getState().currentViewingSessionId === sessionId) trackCatchUp(sessionId, forward);
                        await forward;
                    }
                    caughtUp = true;
                } else if (rendered) {
                    this.unverifiedCacheHits.set(sessionId, hit);
                    const forward = this.fetchForwardAfterCache(sessionId, encryption, hit, signal, { probe: probe.page });
                    // A cached transcript is not "live" (spec B-807 risk 4): 「同步中」 until it caught up.
                    if (storage.getState().currentViewingSessionId === sessionId) trackCatchUp(sessionId, forward);
                    caughtUp = await forward;
                }
            }
            if (!caughtUp) await this.fetchInitialLatestPage(sessionId, encryption, signal);
        } else if (this.unverifiedCacheHits.has(sessionId)) {
            // The check after a cache hit failed (timeout, restart): run it again, not a plain forward.
            if (!(await this.fetchForwardAfterCache(sessionId, encryption, this.unverifiedCacheHits.get(sessionId)!, signal))) {
                await this.fetchInitialLatestPage(sessionId, encryption, signal);
            }
        } else {
            // Forward incremental sync. Used after reconnect, invalidate,
            // or any subsequent visit. Only pulls messages newer than what
            // we already have, so it's bounded and fast in normal use.
            await this.fetchForwardSince(sessionId, encryption, knownLastSeq, signal);
        }

        storage.getState().applyMessagesLoaded(sessionId);
        log.log(`💬 fetchMessages completed for session ${sessionId}`);
    }

    /**
     * B-819: a cold open on /session/:id — start that session's catch-up now,
     * alongside the session list, not when its screen mounts (~900ms after
     * the keys in QA8's runs). Without the key it reads the cache and sends
     * the anchor probe; the list's keys wake it (wakeMessagesAwaitingKeys).
     */
    private startRoutedCatchUp(pathname: string | undefined) {
        const sessionId = routedSessionId(pathname);
        this.routedSession = sessionId;
        if (sessionId) this.getMessagesSync(sessionId).invalidate();
    }

    private isViewed(sessionId: string): boolean {
        return storage.getState().currentViewingSessionId === sessionId || this.routedSession === sessionId;
    }

    /** B-803: abort a catch-up stuck on a dead connection and go again now. */
    private restartMessagesSync(sessionId: string) {
        this.getMessagesSync(sessionId).restart();
    }

    /** One page of history older than `beforeSeq` (the server returns it newest-first). */
    private fetchHistoryPage = (sessionId: string, beforeSeq: number, signal?: AbortSignal) => hedgedRead(async (attemptSignal, pool) => {
        // B-803b: hedged — a page stuck on a dead pooled connection gets a
        // parallel attempt on another one after HEDGE_AFTER_MS (hedgedRead.ts).
        const response = await apiSocket.request(
            `/v3/sessions/${sessionId}/messages?before_seq=${beforeSeq}&limit=${HISTORY_PAGE_SIZE}`,
            { signal: attemptSignal, timeoutMs: SYNC_READ_TIMEOUT_MS, ...pool },
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch history before seq ${beforeSeq} for ${sessionId}: ${response.status}`);
        }
        const data = await response.json() as V3GetSessionMessagesResponse;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        return { messages, hasMore: !!data.hasMore && messages.length > 0 };
    }, { signal })

    private fetchInitialLatestPage = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        signal: AbortSignal,
    ) => {
        // B-616 (historyWindow.ts): the newest page, extended backwards only
        // until the window starts at a turn opener (at most
        // INITIAL_TURN_START_PAGES extra requests), applied as ONE batch so
        // the first paint shows whole turns and tool results meet their
        // calls in the same commit.
        const window: MergeItem<NormalizedMessage>[] = [];
        const rows: ApiMessage[] = [];
        let beforeSeq = SEQ_BACKWARD_INITIAL_SENTINEL;
        let hasMore = false;
        let extraPagesFetched = 0;
        let minSeq = Number.POSITIVE_INFINITY;
        for (;;) {
            const page = await this.fetchHistoryPage(sessionId, beforeSeq, signal);
            for (const message of page.messages) {
                if (message.seq < minSeq) minSeq = message.seq;
            }
            window.push(...await this.normalizeToItems(encryption, page.messages));
            rows.push(...page.messages);
            hasMore = page.hasMore;
            if (!shouldExtendInitialWindow({ hasMore, hasTurnStart: windowHasTurnStart(itemMessages(window)), extraPagesFetched })) break;
            if (!(minSeq > 1)) break;
            beforeSeq = minSeq;
            extraPagesFetched += 1;
        }
        throwIfAborted(signal);

        await this.getSessionMessageLock(sessionId).inLock(() => {
            // B-805: live updates that arrived while the page was loading land
            // in the same commit (the merge drains its reorder buffer); a hole
            // left over is a gap after the reorder window.
            this.mergeSessionMessages(sessionId, window, 'latest-page');
            storage.getState().applyOlderMessagesPagination(sessionId, { hasMore });
        });
        syncCache.offerLatest(sessionId, rows, { viewed: storage.getState().currentViewingSessionId === sessionId });
    }

    private fetchForwardSince = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        fromSeq: number,
        signal: AbortSignal,
        fetchPage: (afterSeq: number, signal: AbortSignal) => Promise<{ messages: ApiMessage[]; hasMore: boolean }>
            = (afterSeq, pageSignal) => this.fetchForwardPage(sessionId, afterSeq, pageSignal),
    ) => {
        const lock = this.getSessionMessageLock(sessionId);
        await catchUpForward<MergeItem<NormalizedMessage>>({
            fetchPage,
            normalize: (page) => this.normalizeToItems(encryption, page.messages as ApiMessage[]),
            withLock: (fn) => lock.inLock(fn),
            merge: (items, page) => { this.mergeSessionMessages(sessionId, items, 'rest', { hasMore: page.hasMore }); },
            onStalled: () => log.log(`💬 fetchForwardSince: pagination stalled for ${sessionId}, stopping to avoid infinite loop`),
        }, fromSeq, signal);
    }

    /** B-813: the session's cached run — read while the key was loading, or now. null = miss. */
    private readCachedRun = async (sessionId: string): Promise<CacheHit | null> => {
        const pending = this.cachePrefetch.get(sessionId);
        this.cachePrefetch.delete(sessionId);
        if (pending && !pending.settled) {
            // B-819: the key is here and the cache is still opening (QA8's loaded machine: the
            // IndexedDB open alone took 500–700ms, longer than the latest page) — waiting would make
            // the cache slower than no cache. Go to the network now; the page lands in the cache.
            log.log(`💬 cache: ${sessionId} not read yet when the key came — network first`);
            return null;
        }
        const prefetched = pending?.load;
        // No cached run → not even one IndexedDB read before the network request.
        if (!prefetched && !syncCache.mayHave(sessionId)) return null;
        const viewed = this.isViewed(sessionId);
        const hit = await (prefetched ?? syncCache.load(sessionId, { viewed }));
        if (hit || !prefetched) return hit ?? null;
        // B-819: a prefetch that missed only because the database was still
        // opening — it is open now and lists this session: read it once more.
        return syncCache.mayHave(sessionId) ? syncCache.load(sessionId, { viewed }) : null;
    }

    /** B-819: ask the cached run's anchor probe now; `takeCacheProbe` hands it to the catch-up. */
    private startCacheProbe(sessionId: string, hit: CacheHit): CacheProbe {
        this.cacheProbes.get(sessionId)?.controller.abort();
        const controller = new AbortController();
        const page = this.fetchForwardPage(sessionId, cacheProbeAfterSeq(hit), controller.signal);
        page.catch(() => {});
        const probe: CacheProbe = { hit, page, controller, startedAt: Date.now() };
        this.cacheProbes.set(sessionId, probe);
        return probe;
    }

    /**
     * B-819: the probe for `hit` — the one asked during the key wait if it is
     * for this run and fresh, else a new one now. It belongs to this attempt:
     * a restart (B-803, `signal`) aborts it; a failed early probe is asked again once.
     */
    private takeCacheProbe(sessionId: string, hit: CacheHit, signal: AbortSignal): CacheProbe {
        const early = this.cacheProbes.get(sessionId);
        this.cacheProbes.delete(sessionId);
        let probe: CacheProbe;
        if (early && isUsableCacheProbe(early, hit, Date.now())) {
            probe = { ...early, page: early.page.catch(() => this.fetchForwardPage(sessionId, cacheProbeAfterSeq(hit), early.controller.signal)) };
        } else {
            early?.controller.abort();
            probe = this.startCacheProbe(sessionId, hit);
            this.cacheProbes.delete(sessionId);
        }
        if (signal.aborted) probe.controller.abort(signal.reason);
        else signal.addEventListener('abort', () => probe.controller.abort(signal.reason), { once: true });
        probe.answer = null;
        probe.page.then((page) => { probe.answer = page; }, () => {});
        return probe;
    }

    /**
     * B-813: render the session's cached run (spec B-807 §5.4) — the same
     * merge as a latest page, before any request answers. null = not
     * rendered; a run that does not decrypt is dropped (§5.4.2) and the cold
     * path runs instead. `droppedMax`: the highest buffered live update left
     * out past a hole (B1) — the catch-up must reach it.
     * `answered` (B-819): the anchor probe's page if it is already here once the
     * run decrypted — then it is checked first (a contradicted run is never
     * shown: null, cold path) and its newer rows land in the SAME commit as
     * the run, so the newest message costs no second render.
     */
    private applyCachedMessages = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        hit: CacheHit,
        signal: AbortSignal,
        answered: () => { messages: ApiMessage[]; hasMore: boolean } | null = () => null,
    ): Promise<CacheRender | null> => {
        // The first paint is the window a latest page would give (B-616): the
        // newest page, extended by whole pages to a turn opener. The older
        // cached rows stay unread; 「加载更早」 pages from the server as before.
        const items: MergeItem<NormalizedMessage>[] = [];
        let start = hit.rows.length;
        let extraPages = 0;
        try {
            for (;;) {
                const end = start;
                start = Math.max(0, end - HISTORY_PAGE_SIZE);
                const page = hit.rows.slice(start, end);
                const decrypted = await encryption.decryptMessages(page);
                if (decrypted.some((message) => !message || message.content === null)) throw new Error('cached row does not decrypt');
                items.unshift(...await this.normalizeToItems(encryption, page));
                if (!shouldExtendInitialWindow({ hasMore: start > 0, hasTurnStart: windowHasTurnStart(itemMessages(items)), extraPagesFetched: extraPages })) break;
                extraPages += 1;
            }
        } catch (error) {
            log.log(`💬 cache: ${sessionId} dropped (${error instanceof Error ? error.message : String(error)})`);
            // The server's copies of these ids must not hit the failed decryptions.
            encryption.forgetMessages(hit.rows.map((row) => row.id));
            syncCache.dropSession(sessionId, 'decrypt');
            return null;
        }
        const oldestSeq = hit.rows[start].seq;
        const page = answered();
        let merged: CacheRender['merged'] = null;
        let newer: MergeItem<NormalizedMessage>[] | null = null;
        if (page) {
            const verdict = checkCacheAnchor(page.messages, hit.lastRowSeq, hit.lastId);
            if (verdict !== 'ok') {
                log.log(`💬 cache: ${sessionId} contradicted by the server (${verdict}) before it rendered`);
                syncCache.dropSession(sessionId, verdict);
                return null;
            }
            // A range result: everything in (lastRowSeq - 1, max] — holes included.
            newer = await this.normalizeToItems(encryption, page.messages.filter((message) => message.seq > hit.lastSeq));
            merged = { hasMore: page.hasMore };
        }
        throwIfAborted(signal);
        let applied = false;
        await this.getSessionMessageLock(sessionId).inLock(() => {
            if (this.lastSeqOf(sessionId) !== undefined) return;
            // B-812: the cached run is a stored range result anchored at its lastSeq
            // (holes included). B1 (B-813): live updates buffered during boot apply only
            // where they continue it; past a hole they wait for the catch-up's range.
            // B-819: the anchor probe's page, checked above, joins it in the same commit — a
            // range result from lastRowSeq - 1 (holes included), so the run anchors at its newest row.
            this.mergeSessionMessages(sessionId, newer ? [...items, ...newer] : items, 'cache', { headSeq: hit.lastSeq });
            storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: oldestSeq > 1 });
            applied = true;
        });
        if (!applied) return null;
        storage.getState().applyMessagesLoaded(sessionId);
        log.log(`💬 cache: ${sessionId} rendered cached seq ${oldestSeq}–${hit.lastSeq}${merged ? ` + checked page to ${this.lastSeqOf(sessionId)}` : ''}`);
        return { merged };
    }

    /**
     * B-813: the catch-up after a cache hit. Its first request asks from
     * lastRowSeq - 1, so the server's first row must be the cached newest row
     * (§5.4.2: missing = the server is behind the cache, another id = not
     * this history). false = the cached transcript was discarded; load cold.
     * `early.probe` (B-819): that request, asked before the run rendered. A
     * live update it predates and the render left out past a hole waits in the
     * merge cursor's reorder buffer; its expiry asks the catch-up (B-812).
     */
    private fetchForwardAfterCache = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        hit: CacheHit,
        signal: AbortSignal,
        early: { probe?: Promise<{ messages: ApiMessage[]; hasMore: boolean }> } = {},
    ): Promise<boolean> => {
        const probe = await (early.probe ?? this.fetchForwardPage(sessionId, cacheProbeAfterSeq(hit), signal));
        throwIfAborted(signal);
        const verdict = checkCacheAnchor(probe.messages, hit.lastRowSeq, hit.lastId);
        this.unverifiedCacheHits.delete(sessionId);
        if (verdict !== 'ok') {
            log.log(`💬 cache: ${sessionId} contradicted by the server (${verdict}), reloading`);
            syncCache.dropSession(sessionId, verdict);
            await this.getSessionMessageLock(sessionId).inLock(() => {
                storage.getState().resetSessionMessages(sessionId);
                const cursor = this.cursor(sessionId);
                resetCursor(cursor);
                cursor.anchorRequested = true;
                this.armReorderTimer(sessionId, cursor);
            });
            return false;
        }
        // From what is already applied: the cached run plus the buffered updates that continued it.
        const fromSeq = Math.max(hit.lastSeq, this.lastSeqOf(sessionId) ?? hit.lastSeq);
        let first: { messages: ApiMessage[]; hasMore: boolean } | null = {
            messages: probe.messages.filter((message) => message.seq > fromSeq),
            hasMore: probe.hasMore,
        };
        await this.fetchForwardSince(sessionId, encryption, fromSeq, signal, (afterSeq, pageSignal) => {
            if (!first) return this.fetchForwardPage(sessionId, afterSeq, pageSignal);
            const page = first;
            first = null;
            return Promise.resolve(page);
        });
        return true;
    }

    /** One forward page (`after_seq`), hedged; every row also goes to the cache. */
    private fetchForwardPage = (sessionId: string, afterSeq: number, signal: AbortSignal) => hedgedRead(async (attemptSignal, pool) => {
        const response = await apiSocket.request(
            `/v3/sessions/${sessionId}/messages?after_seq=${afterSeq}&limit=${HISTORY_PAGE_SIZE}`,
            { signal: attemptSignal, timeoutMs: SYNC_READ_TIMEOUT_MS, ...pool },
        );
        if (!response.ok) {
            throw new Error(`Failed to forward-sync ${sessionId}: ${response.status}`);
        }
        const data = await response.json() as V3GetSessionMessagesResponse;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        syncCache.offerNewer(sessionId, messages, { afterSeq });
        return { messages, hasMore: !!data.hasMore };
    }, { signal })

    /**
     * Decrypt + normalize fetched messages into merge items, carrying the
     * server `seq` through — it is the primary ordering key for rendering
     * (backward pages come newest-first and one transaction's writes share a
     * createdAt). Every seq is kept: `message: null` when nothing renders, so
     * a point source still counts it as seen and a range still covers it.
     */
    private normalizeToItems = async (
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        messages: ApiMessage[]
    ): Promise<MergeItem<NormalizedMessage>[]> => {
        if (messages.length === 0) return [];
        const decryptedMessages = await encryption.decryptMessages(messages);
        return messages.map((raw, i) => {
            const decrypted = decryptedMessages[i];
            const normalized = decrypted ? normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content) : null;
            if (normalized && decrypted) normalized.seq = decrypted.seq;
            return { seq: raw.seq, message: normalized ?? null };
        });
    }

    /**
     * Fetch one page of older messages for a session and prepend them to the
     * store. Called from the chat UI when the reader parks the top of the
     * loaded history in view (B-616) or presses 「加载更早」. No-op when we
     * have already fetched the earliest message, when no initial fetch has
     * happened yet, or when an older-fetch is already in flight for this
     * session.
     */
    loadOlderMessages = async (sessionId: string) => {
        const oldestSeq = this.cursors.get(sessionId)?.oldestSeq;
        if (oldestSeq === undefined || oldestSeq <= 1) {
            return;
        }
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        if (!sessionMessages || sessionMessages.isLoadingOlder || !sessionMessages.hasMoreOlder) {
            return;
        }

        storage.getState().applyOlderMessagesLoading(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        try {
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                log.log(`💬 loadOlderMessages: encryption not ready for ${sessionId}`);
                return;
            }
            // B-803: fetch + decrypt outside the session lock (bounded by
            // SYNC_READ_TIMEOUT_MS); merge under it only if the cursor did
            // not move meanwhile (a reload re-anchored it).
            const beforeSeq = oldestSeq;
            const page = await this.fetchHistoryPage(sessionId, beforeSeq);
            const items = await this.normalizeToItems(encryption, page.messages);
            await lock.inLock(() => {
                if (this.cursors.get(sessionId)?.oldestSeq !== beforeSeq) {
                    return;
                }
                this.mergeSessionMessages(sessionId, items, 'older-page');
                if (page.messages.length > 0) syncCache.offerOlder(sessionId, page.messages, { beforeSeq });
                storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: page.hasMore });
            });
        } finally {
            storage.getState().applyOlderMessagesLoading(sessionId, false);
        }
    }

    private registerPushToken = async () => {
        log.log('registerPushToken');
        // Web: background push goes through Service Worker + Web Push, not Expo.
        // Reconcile the subscription on authenticated startup if the user opted in.
        if (Platform.OS === 'web') {
            if (getNotificationPrefs().enabled) {
                void syncWebPush(this.credentials);
            }
            return;
        }
        try {
            const result = await syncCurrentPushToken(this.credentials);
            log.log('Push token sync result: ' + JSON.stringify({
                registered: result.registered,
                hasToken: !!result.token,
                permission: result.permission.status,
            }));
            if (!result.permission.granted) {
                console.log('Failed to get push token for push notification!');
            }
        } catch (error) {
            log.log('Failed to register push token: ' + JSON.stringify(error));
        }
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));
        // copy_to_clipboard tool: daemon/session pushed text for THIS device's
        // clipboard (decrypt + focus/gesture handling live in clipboardPush).
        apiSocket.onMessage('clipboard-push', (data) => {
            void handleClipboardPush(this.encryption, data);
        });
        // open_preview tool: session pushed an ENCRYPTED absolute path for this
        // account's web clients to preview (decrypt + machine resolution +
        // overlay open live in filePreviewPush). NOTE: onMessage is Map-keyed —
        // one handler per event name, so never reuse a name above.
        apiSocket.onMessage('file-preview-push', (data) => {
            void handleFilePreviewPush(this.encryption, data);
        });
        // B-309: token-level drafts for a running turn. Relayed, never stored;
        // decrypt + fold live in liveStreamStore, deliberately outside the
        // message pipeline (a draft must not re-render the transcript).
        apiSocket.onMessage('session-stream', (data) => {
            void handleSessionStream(this.encryption, data);
        });
        apiSocket.onMessage('session-message-committed', (data) => {
            void this.handleRelayCommittedMessages(data);
        });

        // B-812: the socket went away — subscribe-mode sessions go stale until the next connect's hello.
        apiSocket.onStatusChange((status) => {
            if (status !== 'connected' && this.syncScheduler.getMode() !== 'down') this.syncScheduler.disconnected();
        });
        // B-812: leaving a session keeps its subscription for a while (scheduler retention).
        storage.subscribe((state, prev) => {
            if (state.currentViewingSessionId !== prev.currentViewingSessionId) {
                this.syncScheduler.view(prev.currentViewingSessionId ?? null, state.currentViewingSessionId ?? null);
            }
        });

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            log.log('🔌 Socket reconnected');

            // Send current focus state on reconnect so the server's
            // suppression rules pick up where we left off (handshake.auth.appState
            // covers the very first connect; this covers reconnects).
            apiSocket.sendAppState(getCurrentAppState());

            // B-823: the first connect closes the window between the first
            // list's snapshot and joining the room with a changedSince
            // catch-up, not a second full download (QA9 P2-3); a reconnect
            // after an outage still re-reads the whole list.
            const firstConnect = !this.socketConnectedOnce;
            this.socketConnectedOnce = true;
            if (firstConnect) {
                this.sessionsCatchUpSync.invalidate();
            } else {
                this.sessionsSync.invalidate();
            }
            this.machinesSync.invalidate();
            log.log('🔌 Socket reconnected: Invalidating artifacts sync');
            this.artifactsSync.invalidate();
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
            // B-799 / B-802: a send that failed during the outage may sit in a
            // backoff sleep of up to 10s — cut it short, the link is back now.
            // Send queues only (one wake per reconnect); pollers keep invalidate().
            for (const sync of this.sendSync.values()) {
                sync.invalidateNow();
            }
            this.reloadViewedPromptQueue();
            this.restartStuckCatchUp({ firstConnect });
            this.touchViewedSession();
            // The viewed session's messages must be caught up HERE: nothing
            // else does it after a reconnect (web-v2 has no screen reacting to
            // realtimeStatus; SessionDetailScreen only calls onSessionEnter
            // on mount). Without this, an agent that finished while the link
            // was down never shows its last messages — no new socket event
            // arrives to trigger the seq-gap refetch. B-812: one sync-hello for
            // every subscription (subscribe mode), else the REST catch-up
            // (catchUpViewedSession). Returned so a release handover keeps the
            // old socket until the candidate's hello settled (spec §4.6).
            // B-815: queue prompts that failed on the dead link go out now.
            retryWaitingPrompts();
            return this.syncScheduler.connect('connect');
        });

        // Recovered reconnect (connectionStateRecovery replayed the gap the
        // server knew about). Events emitted into the dead link before the
        // server noticed are gone for good, so refresh the bounded set the
        // current view depends on. Spec §C.
        apiSocket.onRecovered(() => {
            log.log('🔌 Socket recovered — bounded re-sync');
            apiSocket.sendAppState(getCurrentAppState());
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
            this.reloadViewedPromptQueue();
            this.restartStuckCatchUp();
            this.touchViewedSession();
            void this.syncScheduler.connect('recovered');
        });
    }

    private handleRelayCommittedMessages = async (data: unknown) => {
        const payload = data as {
            machineId?: unknown;
            sessionId?: unknown;
            messages?: Array<{
                id?: unknown;
                seq?: unknown;
                localId?: unknown;
                content?: unknown;
                createdAt?: unknown;
                updatedAt?: unknown;
            }>;
        };
        if (typeof payload?.sessionId !== 'string' || !Array.isArray(payload.messages) || payload.messages.length === 0) return;
        const session = storage.getState().sessions[payload.sessionId];
        if (!session || typeof payload.machineId !== 'string' || session.metadata?.machineId !== payload.machineId) return;
        const encryption = this.encryption.getSessionEncryption(payload.sessionId);
        if (!encryption) return;
        const messages: ApiMessage[] = [];
        for (const item of payload.messages) {
            if (typeof item.id !== 'string' || typeof item.seq !== 'number' ||
                (item.localId !== null && typeof item.localId !== 'string') ||
                typeof item.content !== 'string' || typeof item.createdAt !== 'number' || typeof item.updatedAt !== 'number') continue;
            messages.push({
                id: item.id,
                seq: item.seq,
                localId: item.localId,
                content: { t: 'encrypted', c: item.content },
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
            });
        }
        if (messages.length === 0) return;
        const items = await this.normalizeToItems(encryption, messages);
        this.mergeSessionMessages(payload.sessionId, items, 'relay-committed');
    }

    private handleUpdate = async (update: unknown) => {
        const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('❌ Sync: Invalid update received:', validatedUpdate.error);
            console.error('❌ Sync: Invalid update data:', update);
            return;
        }
        const updateData = validatedUpdate.data;
        console.log(`🔄 Sync: Validated update type: ${updateData.body.t}`);

        if (updateData.body.t === 'new-message') {

            // Straggler event for a session that was just deleted (e.g. the
            // death message emitted by the kill that precedes deletion) —
            // ignore it instead of triggering a pointless full refetch.
            if (isSessionDeleted(updateData.body.sid)) {
                return;
            }

            // Get encryption — may not be ready if sessions are still syncing
            let encryption = this.encryption.getSessionEncryption(updateData.body.sid);
            if (!encryption) {
                await this.sessionsSync.awaitQueue();
                encryption = this.encryption.getSessionEncryption(updateData.body.sid);
                if (!encryption) {
                    console.error(`Session ${updateData.body.sid} not found after sync`);
                    this.fetchSessions();
                    return;
                }
            }

            // B-813: the row as the server sent it (ciphertext) extends the cached run.
            if (updateData.body.message) syncCache.offerNewer(updateData.body.sid, [updateData.body.message]);

            // Decrypt message
            let lastMessage: NormalizedMessage | null = null;
            if (updateData.body.message) {
                const decrypted = await encryption.decryptMessage(updateData.body.message);
                if (decrypted) {
                    lastMessage = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
                    if (lastMessage) {
                        // Primary ordering key for rendering (see normalizeToItems).
                        lastMessage.seq = decrypted.seq;
                    }

                    // Check for task lifecycle events to update thinking state
                    // This ensures UI updates even if volatile activity updates are lost
                    const rawContent = decrypted.content as {
                        role?: string;
                        content?: {
                            type?: string;
                            data?: {
                                type?: string;
                                ev?: { t?: string };
                            }
                        }
                    } | null;
                    const contentType = rawContent?.content?.type;
                    const dataType = rawContent?.content?.data?.type;
                    const sessionEventType = rawContent?.content?.data?.ev?.t;
                    
                    // Debug logging to trace lifecycle events
                    if (dataType === 'task_complete' || dataType === 'turn_aborted' || dataType === 'task_started' || sessionEventType === 'turn-start' || sessionEventType === 'turn-end') {
                        console.log(`🔄 [Sync] Lifecycle event detected: contentType=${contentType}, dataType=${dataType}, sessionEventType=${sessionEventType}`);
                    }
                    
                    const isTaskComplete = 
                        ((contentType === 'acp' || contentType === 'codex') && 
                            (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
                        (contentType === 'session' && sessionEventType === 'turn-end');
                    
                    const isTaskStarted = 
                        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
                        (contentType === 'session' && sessionEventType === 'turn-start');
                    
                    // B-805: the update is authoritative — the server is asked only
                    // on a seq gap. B-812: through the merge entry (point source):
                    // contiguous → reduced now; echo (the relay delivered it first)
                    // → dropped; past a hole → the reorder buffer, a gap after
                    // 400ms; no first page yet → buffered until it lands.
                    const sid = updateData.body.sid;
                    const plan = this.mergeSessionMessages(sid, [{ seq: updateData.body.message.seq, message: lastMessage }], 'push');
                    const session = storage.getState().sessions[sid];
                    if (!session) {
                        // Fetch sessions again if we don't have this session
                        this.fetchSessions();
                    } else if (plan.effects.length > 0) {
                        // B-812 rule 6: side effects only for a fact this tab has not
                        // acted on yet (a replayed or duplicate push is not one).
                        if (isTaskComplete || isTaskStarted) {
                            console.log(`🔄 [Sync] Updating thinking state: isTaskComplete=${isTaskComplete}, isTaskStarted=${isTaskStarted}`);
                            // B-322: this is the SECOND writer of `thinking`, and it
                            // carries no heartbeat. Without stamping here, a turn that
                            // starts from a lifecycle event would look instantly stale
                            // and flash "not live" at the top of every turn.
                            recordHeartbeat(sid, isTaskStarted);
                        }
                        this.applySessions([{
                            ...session,
                            updatedAt: updateData.createdAt,
                            seq: updateData.seq,
                            // Update thinking state based on task lifecycle events
                            ...(isTaskComplete ? { thinking: false } : {}),
                            ...(isTaskStarted ? { thinking: true } : {})
                        }]);
                    }
                }
            }

            // Ping session — relay warm + yolo alignment, no fetch (B-805).
            this.onSessionHeartbeat(updateData.body.sid);

        } else if (updateData.body.t === 'new-session') {
            log.log('🆕 New session update received');
            // B-512: the update carries the full row — land it now instead of
            // making the session page wait for a full /v1/sessions refetch.
            // Old servers (id/createdAt/updatedAt only) return false here and
            // behave exactly as before.
            try {
                const applied = await applyNewSessionUpdate(updateData.body, {
                    encryption: this.encryption,
                    getSession: (id) => storage.getState().sessions[id],
                    isDeleted: isSessionDeleted,
                    applySessions: (sessions) => this.applySessions(sessions),
                });
                if (applied) newSessionTimingInStore(updateData.body.id);
            } catch (error) {
                console.error(`Failed to apply new-session ${updateData.body.id} directly:`, error);
            }
            // Backstop: the authoritative list (and anything the update does
            // not carry, e.g. archivedAt / lastMessage) still converges.
            this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'delete-session') {
            log.log('🗑️ Delete session update received');
            this.onSessionDeleted(updateData.body.sid);
        } else if (updateData.body.t === 'update-session') {
            // Straggler update for a just-deleted session (the kill that
            // precedes deletion stamps archive metadata, emitting exactly
            // this update) — never apply it, it would resurrect the session.
            if (isSessionDeleted(updateData.body.id)) {
                return;
            }

            // Session + encryption may not be initialized yet if sessions are
            // still syncing on startup. Mirror the new-message path: await the
            // sessions sync queue and re-check before giving up — dropping here
            // silently loses the metadata update that carries the chat title
            // (#1251: every chat stuck on "New chat" after the lazy-load change).
            let session = storage.getState().sessions[updateData.body.id];
            let sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
            if (!session || !sessionEncryption) {
                await this.sessionsSync.awaitQueue();
                session = storage.getState().sessions[updateData.body.id];
                sessionEncryption = this.encryption.getSessionEncryption(updateData.body.id);
            }
            if (session) {
                if (!sessionEncryption) {
                    console.error(`Session encryption not found for ${updateData.body.id} after sync`);
                    this.fetchSessions();
                    return;
                }

                const agentState = updateData.body.agentState && sessionEncryption
                    ? await sessionEncryption.decryptAgentState(updateData.body.agentState.version, updateData.body.agentState.value)
                    : session.agentState;
                const metadata = updateData.body.metadata && sessionEncryption
                    ? await sessionEncryption.decryptMetadata(updateData.body.metadata.version, updateData.body.metadata.value)
                    : session.metadata;

                this.applySessions([{
                    ...session,
                    agentState,
                    agentStateVersion: updateData.body.agentState
                        ? updateData.body.agentState.version
                        : session.agentStateVersion,
                    metadata,
                    metadataVersion: updateData.body.metadata
                        ? updateData.body.metadata.version
                        : session.metadataVersion,
                    // B-265: the archive / unarchive transition rides a
                    // metadata-less update-session; absent means "no change".
                    ...(updateData.body.archivedAt !== undefined ? { archivedAt: updateData.body.archivedAt } : {}),
                    updatedAt: updateData.createdAt,
                    seq: updateData.seq
                }]);

                if (updateData.body.agentState) {
                    // Check for new permission requests and notify voice assistant
                    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                        const requestIds = Object.keys(agentState.requests);
                        const firstRequest = agentState.requests[requestIds[0]];
                        const toolName = firstRequest?.tool;
                        voiceHooks.onPermissionRequested(updateData.body.id, requestIds[0], toolName, firstRequest?.arguments);
                    }

                    // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                    // This catches up on any messages that were exchanged while desktop had control
                    const wasControlledByUser = session.agentState?.controlledByUser;
                    const isNowControlledByUser = agentState?.controlledByUser;
                    // B-805: a session this tab never opened stays stale — opening it fetches.
                    if (!wasControlledByUser && isNowControlledByUser && (this.messagesSync.has(updateData.body.id) || this.syncScheduler.isSubscribed(updateData.body.id))) {
                        log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                        if (!this.syncScheduler.catchUp(updateData.body.id)) this.getMessagesSync(updateData.body.id).invalidate();
                        this.touchViewedSession(updateData.body.id);
                    }
                }
            } else if (!isSessionDeleted(updateData.body.id)) {
                // The session still isn't in local state even after awaiting the
                // sessions sync queue (e.g. it fell outside the initial /v1/sessions
                // page, or its row hadn't landed yet). Without a compensating fetch
                // this update — which may carry the session's new title (metadata
                // summary) — would be dropped forever, leaving other devices stuck
                // on the old name after a cross-device rename. Force a fresh pull so
                // the authoritative metadata is picked up.
                log.log(`🔄 update-session for unknown session ${updateData.body.id}, forcing sessions refetch`);
                this.sessionsSync.invalidate();
            }
        } else if (updateData.body.t === 'update-account') {
            const accountUpdate = updateData.body;
            const currentProfile = storage.getState().profile;
            const hadGitHub = !!currentProfile.github?.login;

            // Build updated profile with new data
            const updatedProfile: Profile = {
                ...currentProfile,
                firstName: accountUpdate.firstName !== undefined ? accountUpdate.firstName : currentProfile.firstName,
                lastName: accountUpdate.lastName !== undefined ? accountUpdate.lastName : currentProfile.lastName,
                username: accountUpdate.username !== undefined ? accountUpdate.username : currentProfile.username,
                avatar: accountUpdate.avatar !== undefined ? accountUpdate.avatar : currentProfile.avatar,
                github: accountUpdate.github !== undefined ? accountUpdate.github : currentProfile.github,
                timestamp: updateData.createdAt // Update timestamp to latest
            };

            // Apply the updated profile to storage
            storage.getState().applyProfile(updatedProfile);

            if (!hadGitHub && updatedProfile.github?.login) {
                trackGitHubConnected();
            }

            // Handle settings updates (new for profile sync)
            if (accountUpdate.settings?.value) {
                try {
                    const decryptedSettings = await this.encryption.decryptRaw(accountUpdate.settings.value);
                    const parsedSettings = settingsParse(decryptedSettings);

                    // Version compatibility check
                    const settingsSchemaVersion = parsedSettings.schemaVersion ?? 1;
                    if (settingsSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
                        console.warn(
                            `⚠️ Received settings schema v${settingsSchemaVersion}, ` +
                            `we support v${SUPPORTED_SCHEMA_VERSION}. Update app for full functionality.`
                        );
                    }

                    this.applyServerSettings(parsedSettings, accountUpdate.settings.version);
                    log.log(`📋 Settings synced from server (schema v${settingsSchemaVersion}, version ${accountUpdate.settings.version})`);
                } catch (error) {
                    console.error('❌ Failed to process settings update:', error);
                    // Don't crash on settings sync errors, just log
                }
            }
        } else if (updateData.body.t === 'new-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;

            // Brand-new machines (cold onboarding) are delivered via 'new-machine'
            // before any fetchMachines has seen them, so their per-machine
            // encryption isn't initialized yet. The update carries the data
            // encryption key — register it here (mirroring fetchMachines) or every
            // later decrypt for this machine fails and it never lands in storage,
            // leaving the new-session screen unable to start a session until an app
            // restart / socket reconnect triggers a full machine refetch.
            const machineKeysMap = new Map<string, Uint8Array | null>();
            if (machineUpdate.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machineUpdate.dataEncryptionKey);
                if (decryptedKey) {
                    machineKeysMap.set(machineId, decryptedKey);
                    this.machineDataKeys.set(machineId, decryptedKey);
                } else {
                    console.error(`Failed to decrypt data encryption key for new machine ${machineId}`);
                    machineKeysMap.set(machineId, null);
                }
            } else {
                machineKeysMap.set(machineId, null);
            }
            await this.encryption.initializeMachines(machineKeysMap);

            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machineId} after init - cannot apply new-machine`);
                return;
            }

            // Preserve an existing createdAt if we somehow already know this machine.
            const existing = storage.getState().machines[machineId];
            const announceFirstMachine = shouldAnnounceFirstMachine(
                Object.keys(storage.getState().machines).length,
                !!existing,
            );
            const newMachine: Machine = {
                id: machineId,
                seq: machineUpdate.seq,
                createdAt: existing?.createdAt ?? machineUpdate.createdAt,
                updatedAt: machineUpdate.updatedAt,
                active: machineUpdate.active,
                activeAt: machineUpdate.activeAt,
                metadata: null,
                metadataVersion: machineUpdate.metadataVersion,
                daemonState: null,
                daemonStateVersion: machineUpdate.daemonStateVersion
            };

            // Decrypt best-effort; still apply the machine on failure so it stays
            // visible/usable (matches fetchMachines' fallback behavior).
            try {
                newMachine.metadata = machineUpdate.metadata
                    ? await machineEncryption.decryptMetadata(machineUpdate.metadataVersion, machineUpdate.metadata)
                    : null;
                newMachine.daemonState = machineUpdate.daemonState
                    ? await machineEncryption.decryptDaemonState(machineUpdate.daemonStateVersion, machineUpdate.daemonState)
                    : null;
            } catch (error) {
                console.error(`Failed to decrypt new machine ${machineId}:`, error);
            }

            storage.getState().applyMachines([newMachine]);
            if (announceFirstMachine) emitFirstMachineConnected({ machineId });
        } else if (updateData.body.t === 'update-machine') {
            const machineUpdate = updateData.body;
            const machineId = machineUpdate.machineId;  // Changed from .id to .machineId
            const machine = storage.getState().machines[machineId];

            // Create or update machine with all required fields
            const updatedMachine: Machine = {
                id: machineId,
                seq: updateData.seq,
                createdAt: machine?.createdAt ?? updateData.createdAt,
                updatedAt: updateData.createdAt,
                active: machineUpdate.active ?? true,
                activeAt: machineUpdate.activeAt ?? updateData.createdAt,
                metadata: machine?.metadata ?? null,
                metadataVersion: machine?.metadataVersion ?? 0,
                daemonState: machine?.daemonState ?? null,
                daemonStateVersion: machine?.daemonStateVersion ?? 0
            };

            // Get machine-specific encryption (might not exist if machine wasn't initialized)
            const machineEncryption = this.encryption.getMachineEncryption(machineId);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machineId} - cannot decrypt updates`);
                return;
            }

            // If metadata is provided, decrypt and update it
            const metadataUpdate = machineUpdate.metadata;
            if (metadataUpdate) {
                try {
                    const metadata = await machineEncryption.decryptMetadata(metadataUpdate.version, metadataUpdate.value);
                    updatedMachine.metadata = metadata;
                    updatedMachine.metadataVersion = metadataUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine metadata for ${machineId}:`, error);
                }
            }

            // If daemonState is provided, decrypt and update it
            const daemonStateUpdate = machineUpdate.daemonState;
            if (daemonStateUpdate) {
                try {
                    const daemonState = await machineEncryption.decryptDaemonState(daemonStateUpdate.version, daemonStateUpdate.value);
                    updatedMachine.daemonState = daemonState;
                    updatedMachine.daemonStateVersion = daemonStateUpdate.version;
                } catch (error) {
                    console.error(`Failed to decrypt machine daemonState for ${machineId}:`, error);
                }
            }

            // Update storage using applyMachines which rebuilds sessionListViewData
            storage.getState().applyMachines([updatedMachine]);
        } else if (updateData.body.t === 'delete-machine') {
            const machineId = updateData.body.machineId;
            log.log(`🗑️ Delete machine update received for ${machineId}`);
            if (!storage.getState().machines[machineId]) {
                log.log(`Machine ${machineId} not in storage, skipping delete`);
            } else {
                storage.getState().deleteMachine(machineId);
                this.encryption.removeMachineEncryption(machineId);
                this.machineDataKeys.delete(machineId);
            }
        } else if (updateData.body.t === 'session-share') {
            // B-619: someone shared a session with me — it lands in the sidebar as an invitation.
            useSessionShares.getState().onInvite(updateData.body.invite);
        } else if (updateData.body.t === 'session-share-updated') {
            // B-619: an invitation I sent was answered / a role changed. Owners refresh the
            // dialog list; a grantee whose role changed needs the session row re-read.
            const { sessionId, grantId, role, status } = updateData.body;
            useSessionShares.getState().onGrantUpdated(sessionId, grantId, role, status);
            if (storage.getState().sessions[sessionId]?.share) this.sessionsSync.invalidate();
        } else if (updateData.body.t === 'session-share-revoked') {
            // B-619: the owner took the share back (or deleted the session). Purge it like a delete:
            // the key leaves memory and the row leaves the sidebar.
            const { sessionId, grantId } = updateData.body;
            useSessionShares.getState().onRevoked(sessionId, grantId);
            if (storage.getState().sessions[sessionId]?.share) this.onSessionDeleted(sessionId);
        } else if (updateData.body.t === 'relationship-updated') {
            log.log('👥 Received relationship-updated update');
            const relationshipUpdate = updateData.body;
            
            // Apply the relationship update to storage
            storage.getState().applyRelationshipUpdate({
                fromUserId: relationshipUpdate.fromUserId,
                toUserId: relationshipUpdate.toUserId,
                status: relationshipUpdate.status,
                action: relationshipUpdate.action,
                fromUser: relationshipUpdate.fromUser,
                toUser: relationshipUpdate.toUser,
                timestamp: relationshipUpdate.timestamp
            });
            
            // Invalidate friends data to refresh with latest changes
            this.friendsSync.invalidate();
            this.friendRequestsSync.invalidate();
            this.feedSync.invalidate();
        } else if (updateData.body.t === 'new-artifact') {
            log.log('📦 Received new-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            try {
                // Decrypt the data encryption key
                const decryptedKey = await this.encryption.decryptEncryptionKey(artifactUpdate.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt key for new artifact ${artifactId}`);
                    return;
                }
                
                // Store the decrypted key in memory
                this.artifactDataKeys.set(artifactId, decryptedKey);
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(decryptedKey);
                
                // Decrypt header
                const header = await artifactEncryption.decryptHeader(artifactUpdate.header);
                
                // Decrypt body if provided
                let decryptedBody: string | null | undefined = undefined;
                if (artifactUpdate.body && artifactUpdate.bodyVersion !== undefined) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body);
                    decryptedBody = body?.body || null;
                }
                
                // Add to storage
                const decryptedArtifact: DecryptedArtifact = {
                    id: artifactId,
                    title: header?.title || null,
                    body: decryptedBody,
                    headerVersion: artifactUpdate.headerVersion,
                    bodyVersion: artifactUpdate.bodyVersion,
                    seq: artifactUpdate.seq,
                    createdAt: artifactUpdate.createdAt,
                    updatedAt: artifactUpdate.updatedAt,
                    isDecrypted: !!header,
                };
                
                storage.getState().addArtifact(decryptedArtifact);
                log.log(`📦 Added new artifact ${artifactId} to storage`);
            } catch (error) {
                console.error(`Failed to process new artifact ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'update-artifact') {
            log.log('📦 Received update-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Get existing artifact
            const existingArtifact = storage.getState().artifacts[artifactId];
            if (!existingArtifact) {
                console.error(`Artifact ${artifactId} not found in storage`);
                // Fetch all artifacts to sync
                this.artifactsSync.invalidate();
                return;
            }
            
            try {
                // Get the data encryption key from memory
                let dataEncryptionKey = this.artifactDataKeys.get(artifactId);
                if (!dataEncryptionKey) {
                    console.error(`Encryption key not found for artifact ${artifactId}, fetching artifacts`);
                    this.artifactsSync.invalidate();
                    return;
                }
                
                // Create artifact encryption instance
                const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);
                
                // Update artifact with new data  
                const updatedArtifact: DecryptedArtifact = {
                    ...existingArtifact,
                    seq: updateData.seq,
                    updatedAt: updateData.createdAt,
                };
                
                // Decrypt and update header if provided
                if (artifactUpdate.header) {
                    const header = await artifactEncryption.decryptHeader(artifactUpdate.header.value);
                    updatedArtifact.title = header?.title || null;
                    updatedArtifact.sessions = header?.sessions;
                    updatedArtifact.draft = header?.draft;
                    updatedArtifact.headerVersion = artifactUpdate.header.version;
                }
                
                // Decrypt and update body if provided
                if (artifactUpdate.body) {
                    const body = await artifactEncryption.decryptBody(artifactUpdate.body.value);
                    updatedArtifact.body = body?.body || null;
                    updatedArtifact.bodyVersion = artifactUpdate.body.version;
                }
                
                storage.getState().updateArtifact(updatedArtifact);
                log.log(`📦 Updated artifact ${artifactId} in storage`);
            } catch (error) {
                console.error(`Failed to process artifact update ${artifactId}:`, error);
            }
        } else if (updateData.body.t === 'delete-artifact') {
            log.log('📦 Received delete-artifact update');
            const artifactUpdate = updateData.body;
            const artifactId = artifactUpdate.artifactId;
            
            // Remove from storage
            storage.getState().deleteArtifact(artifactId);
            
            // Remove encryption key from memory
            this.artifactDataKeys.delete(artifactId);
        } else if (updateData.body.t === 'new-feed-post') {
            log.log('📰 Received new-feed-post update');
            const feedUpdate = updateData.body;
            
            // Convert to FeedItem with counter from cursor
            const feedItem: FeedItem = {
                id: feedUpdate.id,
                body: feedUpdate.body,
                cursor: feedUpdate.cursor,
                createdAt: feedUpdate.createdAt,
                repeatKey: feedUpdate.repeatKey ?? null,
                counter: parseInt(feedUpdate.cursor.substring(2), 10)
            };
            
            // Check if we need to fetch user for friend-related items
            if (feedItem.body && (feedItem.body.kind === 'friend_request' || feedItem.body.kind === 'friend_accepted')) {
                await this.assumeUsers([feedItem.body.uid]);
                
                // Check if user fetch failed (404) - don't store item if user not found
                const users = storage.getState().users;
                const userProfile = users[feedItem.body.uid];
                if (userProfile === null || userProfile === undefined) {
                    // User was not found or 404, don't store this item
                    log.log(`📰 Skipping feed item ${feedItem.id} - user ${feedItem.body.uid} not found`);
                    return;
                }
            }
            
            // Apply to storage (will handle repeatKey replacement)
            storage.getState().applyFeedItems([feedItem]);

            // B-105: notifications targeting a hidden session (assistant,
            // terminal mirror) never raise user-facing alerts — this was one
            // of the two unfiltered lanes (the other is useAllSessions). The
            // CLI shouldn't generate them for mirrors in the first place;
            // this is the web-side belt-and-braces.
            const feedTarget =
                feedItem.body && feedItem.body.kind === 'notification'
                    ? storage.getState().sessions[feedItem.body.sessionId]
                    : undefined;
            if (feedTarget && isHiddenSession(feedTarget)) return;

            // Web: surface incoming session notifications in the tab title and,
            // when permitted + the tab is unfocused, as a browser Notification.
            if (feedItem.body && feedItem.body.kind === 'notification') {
                notifyUnreadMessage();
                this.maybeRaiseWebNotification(feedItem.body);
                // B-086: a notification for the session currently on screen is
                // already seen — stamp its target immediately so the unread
                // badge never contradicts the self-view (createdAt is server
                // time; the stamp helper handles bounded clock skew).
                stampSeenOnArrival(
                    feedItem.body.sessionId,
                    `/session/${feedItem.body.sessionId}`,
                    feedItem.createdAt,
                );
                // Chime (independent of the browser-Notification permission and
                // of decryption — the type/session ride in plaintext). The gate
                // handles prefs, quiet hours, self-view and the cross-lane
                // cooldown against the board-transition producer.
                maybePlayNotificationSound({
                    event: soundEventOfNotifType(feedItem.body.notifType),
                    key: feedItem.body.sessionId,
                    href: `/session/${feedItem.body.sessionId}`,
                    error: feedItem.body.notifType === 'error',
                });
            }
        } else if (updateData.body.t === 'prompt-queue') {
            // B-509: server-side prompt queue snapshot for one session.
            applyPromptQueueUpdate(updateData.body, updateData.seq);
        } else if (updateData.body.t === 'kv-batch-update') {
            // Realtime account-KV changes (the server has always broadcast
            // these). Fanned out to the KV-backed stores — e.g. the synced
            // notification read state, so opening a session on one device
            // clears its notifications on the others without polling.
            dispatchKvChanges(updateData.body.changes);
        } else if (updateData.body.t === 'attention-item') {
            // B-766: 汇报板 item snapshot (full item; the store keeps the highest version).
            applyAttentionItem(updateData.body.item);
        }
    }

    /**
     * Web-only: decrypt an incoming notification feed body and (subject to user
     * prefs / focus) raise a foreground browser Notification. Best-effort —
     * decryption failures are swallowed so a foreign/corrupt item never breaks
     * the socket update loop.
     */
    private maybeRaiseWebNotification(body: Extract<FeedBody, { kind: 'notification' }>) {
        if (Platform.OS !== 'web') return;
        try {
            const credentials = this.getCredentials();
            if (!credentials) return;
            const seed = decodeBase64(credentials.secret, 'base64url');
            const payload = decryptNotificationEnc(body.enc, seed);
            if (!payload) return;
            maybeShowNotification({
                type: body.notifType,
                sessionId: body.sessionId,
                title: payload.title,
                body: payload.snippet,
            });
        } catch (e) {
            log.log(`🔔 maybeRaiseWebNotification failed: ${e}`);
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        // log.log(`🔄 Flushing activity updates for ${updates.size} sessions - acquiring lock`);


        const sessions: Session[] = [];

        for (const [sessionId, update] of updates) {
            const session = storage.getState().sessions[sessionId];
            if (session) {
                sessions.push({
                    ...session,
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: update.thinking ?? false,
                    thinkingAt: update.activeAt // Always use activeAt for consistency
                });
            }
        }

        if (sessions.length > 0) {
            // console.log('flushing activity updates ' + sessions.length);
            this.applySessions(sessions);
            // log.log(`🔄 Activity updates flushed - updated ${sessions.length} sessions`);
        }
    }

    private handleEphemeralUpdate = (update: unknown) => {
        const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
        if (!validatedUpdate.success) {
            console.log('Invalid ephemeral update received:', validatedUpdate.error);
            console.error('Invalid ephemeral update received:', update);
            return;
        } else {
            // console.log('Ephemeral update received:', update);
        }
        const updateData = validatedUpdate.data;

        // Process activity updates through smart debounce accumulator
        if (updateData.type === 'activity') {
            // B-322: stamp the LOCAL receive time here, BEFORE the accumulator.
            // A plain timestamp heartbeat is not a "significant change", so it
            // sits in a 2s debounce whose timer is deliberately not reset —
            // stamping at flush time would silently eat that much of the TTL.
            // B-507: the count first — it decides whether the lease timer is
            // armed; an inactive broadcast carries no field and zeroes it.
            recordBackgroundTasks(updateData.id, updateData.active ? updateData.backgroundTasks : undefined);
            recordHeartbeat(updateData.id, updateData.thinking === true);
            // console.log('adding activity update ' + updateData.id);
            this.activityAccumulator.addUpdate(updateData);
        }

        // Handle machine activity updates
        if (updateData.type === 'machine-activity') {
            // Update machine's active status and lastActiveAt
            const machine = storage.getState().machines[updateData.id];
            if (machine) {
                const updatedMachine: Machine = {
                    ...machine,
                    active: updateData.active,
                    activeAt: updateData.activeAt
                };
                storage.getState().applyMachines([updatedMachine]);
            }
        }

        // Session-level lifecycle event (Claude finished, needs permission, asks question).
        // This is the same signal that triggers the mobile push — bump browser-tab
        // unread counter on these only, ignore the noisy per-message stream.
        if (updateData.type === 'session-event') {
            notifyUnreadMessage();
            // B-510: request_human → banner on that session.
            const attention = attentionFromEvent(updateData);
            if (attention) useHumanAttention.getState().report(updateData.sessionId, attention);
        }

        // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    }

    //
    // Apply store
    //

    //
    // B-812: merge entry + catch-up scheduler (B-807 spec §5.1–5.3)
    //

    private cursor(sessionId: string): SessionCursor<NormalizedMessage> {
        let cursor = this.cursors.get(sessionId);
        if (!cursor) {
            cursor = createCursor();
            this.cursors.set(sessionId, cursor);
        }
        return cursor;
    }

    private lastSeqOf(sessionId: string): number | undefined {
        return this.cursors.get(sessionId)?.lastSeq;
    }

    /**
     * B-812 (spec §5.1): the single merge entry of a session's messages — live
     * push, send ack, relay commit, socket snapshot, REST catch-up, latest and
     * older pages. Synchronous: callers that went to the network merge inside
     * the session lock, and nothing awaits between the cursor decision and the
     * store write, so no other merge interleaves.
     */
    private mergeSessionMessages(sessionId: string, items: MergeItem<NormalizedMessage>[], source: MergeSource, meta: Omit<MergeMeta, 'now'> = {}): MergePlan<NormalizedMessage> {
        const cursor = this.cursor(sessionId);
        const plan = planMerge(cursor, items, source, { ...meta, now: Date.now() });
        // A window that is not contiguous with the new page goes — unless unsent
        // inputs live in it (their bubbles must not vanish; the page still anchors).
        if (plan.resetWindow && !this.hasPendingOutbox(sessionId)) storage.getState().resetSessionMessages(sessionId);
        if (plan.apply.length > 0) this.writeMessagesToStore(sessionId, plan.apply);
        // B-805: a never-opened session's first update asks for its latest page once.
        if (plan.needAnchor && !this.syncScheduler.drives(sessionId)) this.getMessagesSync(sessionId).invalidate();
        this.armReorderTimer(sessionId, cursor);
        return plan;
    }

    private hasPendingOutbox(sessionId: string): boolean {
        if ((this.pendingOutbox.get(sessionId)?.length ?? 0) > 0) return true;
        for (const record of this.outboxRecords.values()) if (record.sessionId === sessionId) return true;
        return false;
    }

    /** Rule 4: a hole still open when the reorder window closes is a gap → one catch-up. */
    private armReorderTimer(sessionId: string, cursor: SessionCursor<NormalizedMessage>) {
        const existing = this.reorderTimers.get(sessionId);
        if (cursor.reorderDeadline === undefined) {
            if (existing) clearTimeout(existing);
            this.reorderTimers.delete(sessionId);
            return;
        }
        if (existing) return;
        this.reorderTimers.set(sessionId, setTimeout(() => {
            this.reorderTimers.delete(sessionId);
            if (this.cursors.get(sessionId) !== cursor) return;
            const gap = expireReorder(cursor, Date.now());
            if (!gap) {
                this.armReorderTimer(sessionId, cursor);
                return;
            }
            log.log(`💬 seq gap ${gap.from}..${gap.to} in ${sessionId} after the reorder window`);
            if (!this.syncScheduler.gap(sessionId)) {
                this.getMessagesSync(sessionId).invalidate();
                // B-804: a gap in the viewed session — say so if it takes a while.
                this.trackMessagesCatchUp(sessionId);
            }
        }, Math.max(0, cursor.reorderDeadline - Date.now())));
    }

    /** headSeq behind the request (spec §6.2-10) or a cold restart: forget the window and cursor. */
    private invalidateSessionWindow(sessionId: string) {
        // §5.4.2: local state ahead of the server — the cached run goes too.
        this.unverifiedCacheHits.delete(sessionId);
        syncCache.dropSession(sessionId, 'behind');
        const cursor = this.cursor(sessionId);
        resetCursor(cursor);
        this.armReorderTimer(sessionId, cursor);
        if (!this.hasPendingOutbox(sessionId)) storage.getState().resetSessionMessages(sessionId);
    }

    /**
     * B-812 S12: the session's key — now, or once the FIRST session list of
     * this load landed (not a full fetch a resume / reconnect queued behind
     * it: one more 1.8MB download on slow 4G for the biggest account). A
     * session the first list did not carry (created since) waits for the
     * first connect's changedSince catch-up (B-823), then the list queue.
     */
    private async awaitSessionEncryption(sessionId: string) {
        const now = this.encryption.getSessionEncryption(sessionId);
        if (now) return now;
        if (!this.firstSessionsList.settled) await Promise.race([this.firstSessionsList.promise, this.sessionsSync.awaitQueue()]);
        const listed = this.encryption.getSessionEncryption(sessionId);
        if (listed) return listed;
        await this.sessionsCatchUpSync.awaitQueue();
        const caughtUp = this.encryption.getSessionEncryption(sessionId);
        if (caughtUp) return caughtUp;
        await this.sessionsSync.awaitQueue();
        return this.encryption.getSessionEncryption(sessionId) ?? null;
    }

    /**
     * B-813 × B-812: a cold open in subscribe mode renders the cached run first;
     * the subscribe that follows asks from its newest row - 1 to check it
     * (requestAfterSeq / applySubscribeResult).
     */
    private prepareColdOpen = async (sessionId: string): Promise<void> => {
        if (this.lastSeqOf(sessionId) !== undefined || !syncCache.mayHave(sessionId)) return;
        const encryption = await this.awaitSessionEncryption(sessionId);
        if (!encryption) return;
        // B-819: the run read while the key loaded (a prefetch still opening the database → cold).
        const hit = await this.readCachedRun(sessionId);
        if (!hit) return;
        if (await this.applyCachedMessages(sessionId, encryption, hit, new AbortController().signal)) this.unverifiedCacheHits.set(sessionId, hit);
    };

    /** One ok sync-hello / session-subscribe result → decrypt → the merge entry. */
    private applySubscribeResult = async (sessionId: string, result: SyncSubResultOk, request: SubscribeRequest): Promise<AckOutcome> => {
        const encryption = await this.awaitSessionEncryption(sessionId);
        if (!encryption) throw new Error(`Session encryption not ready for ${sessionId}`);
        const latest = request.afterSeq === null || result.gapTooLarge === true;
        // B-813 §5.4.2: the cached run's newest row must be the server's row of that seq.
        const hit = this.unverifiedCacheHits.get(sessionId);
        if (hit && !latest && request.afterSeq === Math.max(0, hit.lastRowSeq - 1) && (result.messages.length > 0 || !result.hasMore)) {
            const verdict = checkCacheAnchor(result.messages as ApiMessage[], hit.lastRowSeq, hit.lastId);
            this.unverifiedCacheHits.delete(sessionId);
            if (verdict !== 'ok') {
                log.log(`💬 cache: ${sessionId} contradicted by the server (${verdict}), reloading`);
                syncCache.dropSession(sessionId, verdict);
                return { t: 'head-behind' };
            }
        }
        if (latest) this.unverifiedCacheHits.delete(sessionId);
        // A budget-exhausted latest page (empty, hasMore) has nothing to anchor: ask again (cold).
        if (latest && result.messages.length === 0 && result.hasMore) return { t: 'more' };
        const rows = result.messages as ApiMessage[];
        let items = await this.normalizeToItems(encryption, rows);
        let hasMoreOlder = items.length > 0 && items[0].seq > 1;
        let olderRows: ApiMessage[] = [];
        if (latest) ({ items, hasMoreOlder, olderRows } = await this.extendLatestWindow(sessionId, encryption, items, hasMoreOlder));
        let plan: MergePlan<NormalizedMessage> | null = null;
        await this.getSessionMessageLock(sessionId).inLock(() => {
            const cursor = this.cursor(sessionId);
            // Rule 1: generations are the scheduler's (a re-subscribed session starts over at 0).
            cursor.generation = this.syncScheduler.phase(sessionId)?.generation ?? request.generation;
            plan = this.mergeSessionMessages(sessionId, items, latest ? 'latest-page' : 'snapshot', {
                generation: request.generation,
                afterSeq: request.afterSeq,
                headSeq: result.headSeq,
                hasMore: result.hasMore,
                gapTooLarge: result.gapTooLarge === true,
            });
            if (latest && plan.outcome === 'merged') storage.getState().applyOlderMessagesPagination(sessionId, { hasMore: hasMoreOlder });
        });
        const merged = plan as MergePlan<NormalizedMessage> | null;
        if (!merged) return { t: 'superseded' };
        if (merged.outcome === 'superseded') return { t: 'superseded' };
        if (merged.outcome === 'head-behind') return { t: 'head-behind' };
        if (merged.outcome === 'invalid') return { t: 'invalid' };
        // B-813: the server's rows extend (or, for a latest page, restart) the cached run.
        if (latest) syncCache.offerLatest(sessionId, [...olderRows, ...rows], { viewed: storage.getState().currentViewingSessionId === sessionId });
        else syncCache.offerNewer(sessionId, rows, { afterSeq: request.afterSeq! });
        storage.getState().applyMessagesLoaded(sessionId);
        return merged.live ? { t: 'live' } : { t: 'more' };
    };

    /** B-616 first-paint window for a socket latest page: extend backwards to a turn opener (REST, bounded). */
    private async extendLatestWindow(
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        items: MergeItem<NormalizedMessage>[],
        hasMore: boolean,
    ): Promise<{ items: MergeItem<NormalizedMessage>[]; hasMoreOlder: boolean; olderRows: ApiMessage[] }> {
        let window = items;
        let olderRows: ApiMessage[] = [];
        let extraPagesFetched = 0;
        while (window.length > 0 && window[0].seq > 1
            && shouldExtendInitialWindow({ hasMore, hasTurnStart: windowHasTurnStart(itemMessages(window)), extraPagesFetched })) {
            const page = await this.fetchHistoryPage(sessionId, window[0].seq);
            const older = await this.normalizeToItems(encryption, page.messages);
            hasMore = page.hasMore;
            extraPagesFetched += 1;
            if (older.length === 0) break;
            window = [...older.sort((a, b) => a.seq - b.seq), ...window];
            olderRows = [...[...page.messages].sort((a, b) => a.seq - b.seq), ...olderRows];
        }
        return { items: window, hasMoreOlder: hasMore, olderRows };
    }

    /**
     * B-803 at connect / resume, whatever the mode turns out to be: a REST
     * catch-up in flight on the link that just died is restarted now (as before B-812).
     * B-823: not on the page's first connect — no link was lost, the boot's first page
     * is healthy (aborting it re-downloaded the latest page on the critical path); a
     * coalesced forward run follows it instead (the read predates joining the room).
     */
    private restartStuckCatchUp(opts?: { firstConnect?: boolean }) {
        const viewing = storage.getState().currentViewingSessionId;
        const messages = viewing ? this.messagesSync.get(viewing) : undefined;
        if (!viewing || !messages?.isRunning()) return;
        if (opts?.firstConnect) messages.invalidate();
        else this.restartMessagesSync(viewing);
    }

    /** The legacy reaction to a trigger the scheduler does not take over the socket. */
    private legacyCatchUp(reason: HelloReason | 'open', sessionId?: string) {
        if (reason === 'open') {
            if (sessionId) this.getMessagesSync(sessionId).invalidate();
            return;
        }
        if (reason === 'connect' || reason === 'recovered' || reason === 'handover') {
            // Decided up to 2s after the connect (no ack from an old server): a catch-up running
            // now started after restartStuckCatchUp — let it land instead of aborting it again
            // (e2e OLDSERVER: the first screen lost ~350ms to that restart).
            const viewing = storage.getState().currentViewingSessionId;
            if (!viewing) return;
            const messages = this.getMessagesSync(viewing);
            if (!messages.isRunning()) messages.invalidate();
            this.trackMessagesCatchUp(viewing);
            return;
        }
        this.catchUpViewedSession();
    }

    /** Subscribe-mode phases → the B-804 chat line (同步中 / 连接不稳定 · 重试), spec §5.3 UI mapping. */
    private onSyncPhase(sessionId: string, state: SessionSyncState | null) {
        const previous = this.syncPhases.get(sessionId);
        if (state) this.syncPhases.set(sessionId, state.phase);
        else this.syncPhases.delete(sessionId);
        const catchingUp = state !== null && (state.phase === 'syncing' || (state.phase === 'stale' && state.staleReason !== 'offline'));
        if (catchingUp) {
            // A fresh attempt after stale (retry / reconnect) starts the line over: 「同步中」, the slow clock again.
            if (state.phase === 'syncing' && (!this.syncTracking.has(sessionId) || previous === 'stale')
                && storage.getState().currentViewingSessionId === sessionId) {
                this.syncTracking.get(sessionId)?.();
                let release!: () => void;
                const done = new Promise<void>((resolve) => { release = resolve; });
                this.syncTracking.set(sessionId, release);
                trackCatchUp(sessionId, done, { slowMs: SUBSCRIBE_SLOW_MS });
            }
            return;
        }
        const release = this.syncTracking.get(sessionId);
        this.syncTracking.delete(sessionId);
        release?.();
    }

    private createSyncScheduler(): SessionSyncScheduler {
        return new SessionSyncScheduler({
            emit: (event, payload, timeoutMs) => apiSocket.emitWithTimeout(event, payload, timeoutMs),
            connected: () => apiSocket.isControlConnected(),
            lastSeq: (sid) => this.lastSeqOf(sid),
            coldLimit: HISTORY_PAGE_SIZE,
            prepareCold: (sid) => this.prepareColdOpen(sid),
            requestAfterSeq: (sid) => {
                const hit = this.unverifiedCacheHits.get(sid);
                return hit ? Math.max(0, hit.lastRowSeq - 1) : undefined;
            },
            applyResult: (sid, result, request) => this.applySubscribeResult(sid, result, request),
            invalidate: (sid) => this.invalidateSessionWindow(sid),
            rest: (sid) => {
                // The socket answered nothing: REST, and do not wait on a dead pooled connection first.
                armHedgeBurst();
                this.restartMessagesSync(sid);
                this.trackMessagesCatchUp(sid);
                return this.getMessagesSync(sid).awaitQueue();
            },
            legacy: (reason, sid) => this.legacyCatchUp(reason as HelloReason | 'open', sid),
            checkLiveness: () => { void apiSocket.checkLiveness(); },
            offline: () => !isBrowserOnline(),
            visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
            viewing: () => storage.getState().currentViewingSessionId ?? null,
            forcedLegacy: forcedLegacySyncMode,
            lastMode: () => {
                try {
                    const mode = localStorage.getItem('vh.sync.lastMode');
                    return mode === 'legacy' || mode === 'subscribe' ? mode : null;
                } catch {
                    return null;
                }
            },
            noteMode: (mode) => {
                try { localStorage.setItem('vh.sync.lastMode', mode); } catch { /* private mode: no hint */ }
            },
            onPhase: (sid, state) => this.onSyncPhase(sid, state),
            onRemoved: () => this.sessionsSync.invalidate(),
            now: () => Date.now(),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            random: () => Math.random(),
            log: (message) => log.log(message),
        });
    }

    /**
     * The one store write of a session's messages. Called by
     * mergeSessionMessages (every server source) and applyOptimistic (a local
     * input, no seq) only — asserted in sessionMerge.test.ts.
     */
    private writeMessagesToStore = (sessionId: string, messages: NormalizedMessage[], sendingLocalIds?: readonly string[]) => {
        const result = storage.getState().applyMessages(sessionId, messages, sendingLocalIds ? { sendingLocalIds } : undefined);
        if (this.outboxRecords.size > 0) this.pruneOutboxRecords(sessionId);
        settleDispatchedPrompts(sessionId);
        let m: Message[] = [];
        for (let messageId of result.changed) {
            const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
            if (message) {
                m.push(message);
            }
        }
        if (m.length > 0) {
            voiceHooks.onMessages(sessionId, m);
        }
        if (result.hasReadyEvent) {
            voiceHooks.onReady(sessionId);
        }
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[]) => {
        const active = storage.getState().getActiveSessions();
        storage.getState().applySessions(sessions);
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
        this.wakeMessagesAwaitingKeys();
    }

    /**
     * B-819: a catch-up that failed for want of its session key sleeps in
     * backoff (up to seconds by the time a slow list lands). The key is here
     * now: go at once — the cold open's first paint waited on that sleep.
     */
    private wakeMessagesAwaitingKeys() {
        for (const sessionId of [...this.messagesAwaitingKeys]) {
            if (!this.encryption.getSessionEncryption(sessionId)) continue;
            this.messagesAwaitingKeys.delete(sessionId);
            this.messagesSync.get(sessionId)?.wake();
        }
    }

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id)) {
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);
    installRpcRateLimitNotice();
    // B-619: publish the content public key so this account can RECEIVE shared
    // sessions even when its master secret is not server-held. Best effort.
    void uploadContentPublicKey(encodeBase64ForShare(encryption.contentDataKey)).catch(() => { /* old server */ });

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}
