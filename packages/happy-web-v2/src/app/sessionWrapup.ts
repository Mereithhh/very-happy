/**
 * B-915 built-in session actions 「收尾」 (wrap-up) and 「交接给…」 (handoff).
 *
 * One entry for the session header ⋯, the sidebar row ⋯ and the composer's
 * `/wrapup`: each sends the session an ORDINARY user turn whose text comes from
 * happy-wire (`buildWrapupPrompt` / `buildHandoffPrompt`, the same words the
 * CLI and MCP entry points send). The chat shows only a short label
 * (`displayText`); the localId prefix (`wrapup-` / `handoff-`) lets a new
 * wrapper mark the run as a 「收尾中…」 card. The result card is posted by the
 * agent's `wrapup_report` / `session_handoff` tool, not by the Web.
 *
 * Idempotent per session and mode: while the board already holds a fresh
 * `running` card (`wrapupInProgress`), a second click only says so.
 * Old wrappers (no `wrapup-v1`) still get the turn — the prompt asks them for a
 * plain list instead — and the toast explains that upgrading the CLI adds the card.
 */
import {
    WRAPUP_KV_KEY, WRAPUP_SESSION_CAPABILITY, buildHandoffPrompt, buildWrapupPrompt, decodeWrapupConfig, encodeWrapupConfig,
    handoffDisplayText, handoffLocalId, resolveWrapupTemplate, wrapupDisplayText, wrapupInProgress, wrapupLocalId,
    type AttentionItem, type WrapupConfig, type WrapupLang,
} from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { t } from '@/i18n/useTranslation';
import { getCurrentLanguage } from '@/text';
import { kvGet, kvMutate } from '@/sync/apiKv';
import { listAttentionItems } from '@/sync/apiAttention';
import { useAttentionStore } from '@/sync/attentionStore';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { toast } from '@/ui/Toast';
import { composerGate, restoreSession } from './sessionRestore';

export type WrapupMode = 'wrapup' | 'handoff';
export type HandoffRequest = { to: { id: string; title: string | null; machineId: string | null }; note: string; archiveAfter: boolean };
export type BuiltinActionOutcome = 'sent' | 'already' | 'restore-failed' | 'not-live' | 'failed' | 'missing';

export function wrapupLangOf(lang: string | null | undefined): WrapupLang {
    return (lang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** The wrapper registers `wrapup_report` / `session_handoff` (per-session capability, AGENTS #14). */
export function supportsWrapupCard(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    return session?.metadata?.capabilities?.includes(WRAPUP_SESSION_CAPABILITY) === true;
}

// ─── account template (KV) ───────────────────────────────────────────────────

export interface WrapupConfigState { config: WrapupConfig; version: number }

/** Read the account template; a missing key / failure → defaults (version -1 = not stored yet). */
export async function loadWrapupConfig(): Promise<WrapupConfigState> {
    const creds = getCurrentAuth()?.credentials;
    if (!creds) return { config: { template: null }, version: -1 };
    try {
        const item = await kvGet(creds, WRAPUP_KV_KEY);
        return item ? { config: decodeWrapupConfig(item.value), version: item.version } : { config: { template: null }, version: -1 };
    } catch {
        return { config: { template: null }, version: -1 };
    }
}

export type SaveWrapupResult = { ok: true; version: number } | { ok: false; conflict: WrapupConfigState | null };

/** Optimistic-concurrency write (KV `version`); a mismatch returns the server's current value. */
export async function saveWrapupConfig(config: WrapupConfig, version: number): Promise<SaveWrapupResult> {
    const creds = getCurrentAuth()?.credentials;
    if (!creds) return { ok: false, conflict: null };
    const result = await kvMutate(creds, [{ key: WRAPUP_KV_KEY, value: encodeWrapupConfig(config), version }]);
    if (result.success) return { ok: true, version: result.results[0]?.version ?? version + 1 };
    const err = result.errors[0];
    return { ok: false, conflict: err ? { config: decodeWrapupConfig(err.value), version: err.version } : null };
}

// ─── sending the turn ────────────────────────────────────────────────────────

function nonce(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Board items of the session: a fresh fetch (the session may not be open), else the store's copy. */
async function sessionItems(sessionId: string): Promise<readonly AttentionItem[]> {
    try {
        return (await listAttentionItems({ sessionId, state: 'open', limit: 50 })).items;
    } catch {
        return useAttentionStore.getState().bySession[sessionId] ?? [];
    }
}

const LIVE_WAIT_MS = 90_000;
/** KV reads retry with backoff; a wrap-up click must not hang on them — past this, the built-in template goes. */
const CONFIG_WAIT_MS = 5_000;
function loadConfigQuickly(): Promise<WrapupConfigState> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ config: { template: null }, version: -1 }), CONFIG_WAIT_MS);
        void loadWrapupConfig().then((state) => { clearTimeout(timer); resolve(state); });
    });
}
function waitForLive(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (storage.getState().sessions[sessionId]?.active) return Promise.resolve(true);
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => { if (done) return; done = true; unsubscribe(); clearTimeout(timer); resolve(ok); };
        const unsubscribe = storage.subscribe((state) => { if (state.sessions[sessionId]?.active) finish(true); });
        const timer = setTimeout(() => finish(false), timeoutMs);
    });
}

export interface BuiltinActionDeps {
    getSession: (id: string) => Session | undefined;
    items: (sessionId: string) => Promise<readonly AttentionItem[]>;
    loadConfig: () => Promise<WrapupConfigState>;
    gate: (session: Session) => 'send' | 'restore-first';
    restore: (sessionId: string) => Promise<boolean>;
    waitLive: (sessionId: string) => Promise<boolean>;
    send: (sessionId: string, text: string, options: { localId: string; displayText: string }) => Promise<unknown>;
    notify: (kind: 'success' | 'info' | 'error', message: string) => void;
    lang: () => WrapupLang;
    now: () => number;
    nonce: () => string;
}

const defaultDeps: BuiltinActionDeps = {
    getSession: (id) => storage.getState().sessions[id],
    items: sessionItems,
    loadConfig: loadConfigQuickly,
    gate: (session) => composerGate(session),
    restore: restoreSession,
    waitLive: (id) => waitForLive(id, LIVE_WAIT_MS),
    send: (sessionId, text, options) => sync.sendMessage(sessionId, text, { source: 'chat', delivery: 'queue', ...options }),
    notify: (kind, message) => (kind === 'success' ? toast.success(message) : kind === 'error' ? toast.error(message) : toast.show(message, 'info')),
    lang: () => wrapupLangOf(getCurrentLanguage()),
    now: () => Date.now(),
    nonce,
};

/**
 * Send the wrap-up (no `handoff`) or handoff turn to `sessionId`. Returns what
 * happened; every outcome has already been told to the user.
 */
export async function runBuiltinAction(sessionId: string, handoff: HandoffRequest | null, overrides: Partial<BuiltinActionDeps> = {}): Promise<BuiltinActionOutcome> {
    const deps = { ...defaultDeps, ...overrides };
    const mode: WrapupMode = handoff ? 'handoff' : 'wrapup';
    const session = deps.getSession(sessionId);
    if (!session) { deps.notify('error', t('wrapup.sendFailed')); return 'missing'; }
    const now = deps.now();
    const items = await deps.items(sessionId);
    if (items.some((item) => wrapupInProgress(item, mode, now))) {
        deps.notify('info', t(mode === 'handoff' ? 'wrapup.handoffAlready' : 'wrapup.already'));
        return 'already';
    }
    const lang = deps.lang();
    let text: string;
    let displayText: string;
    let localId: string;
    if (handoff) {
        text = buildHandoffPrompt({ to: handoff.to, note: handoff.note, archiveAfter: handoff.archiveAfter && supportsWrapupCard(session) });
        displayText = handoffDisplayText(lang, handoff.to.title);
        localId = handoffLocalId(deps.nonce());
    } else {
        const { config } = await deps.loadConfig();
        text = buildWrapupPrompt(resolveWrapupTemplate(config, lang));
        displayText = wrapupDisplayText(lang);
        localId = wrapupLocalId(deps.nonce());
    }
    // An offline / hibernated session would drop a plain send (B-680): bring it back first.
    if (deps.gate(session) === 'restore-first') {
        deps.notify('info', t('wrapup.restoring'));
        if (!(await deps.restore(sessionId))) { deps.notify('error', t('wrapup.restoreFailed')); return 'restore-failed'; }
        if (!(await deps.waitLive(sessionId))) { deps.notify('error', t('wrapup.notLive')); return 'not-live'; }
    }
    try {
        await deps.send(sessionId, text, { localId, displayText });
    } catch {
        deps.notify('error', t('wrapup.sendFailed'));
        return 'failed';
    }
    if (!supportsWrapupCard(deps.getSession(sessionId) ?? session)) deps.notify('info', t('wrapup.upgradeHint'));
    else deps.notify('success', t(mode === 'handoff' ? 'wrapup.handoffSent' : 'wrapup.sent'));
    return 'sent';
}

export function startWrapup(sessionId: string): Promise<BuiltinActionOutcome> {
    return runBuiltinAction(sessionId, null);
}

export function startHandoff(sessionId: string, request: HandoffRequest): Promise<BuiltinActionOutcome> {
    return runBuiltinAction(sessionId, request);
}

// ─── dialog opener (one global listener, so a sidebar row needs no modal of its own) ──

type HandoffOpener = (sessionId: string) => void;
let handoffOpener: HandoffOpener | null = null;
export function registerHandoffOpener(fn: HandoffOpener | null): void {
    handoffOpener = fn;
}
export function openHandoffDialog(sessionId: string): void {
    handoffOpener?.(sessionId);
}
