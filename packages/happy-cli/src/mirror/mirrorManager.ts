/**
 * Terminal mirror (B-105) — daemon-side orchestrator.
 *
 * Owns one shadow session per vh web terminal that runs a hand-typed claude:
 *   hook (via controlServer /terminal-hook) → binding state machine
 *   (mirrorProtocol) → shadow ApiSessionClient hosted IN the daemon (a new
 *   shape — the daemon never hosted session clients before; outbox is
 *   in-memory, daemon crashes are absorbed by localId idempotency, M1)
 *   → offset-tail scanner (mirrorScanner) feeding transcript lines through
 *   the SAME protocol mapper the normal session path uses.
 *
 * Key discipline (B2 / B-051 tombstone): every new shadow session mints a
 * RANDOM tag (never a fixed reusable tag), and daemon restarts reconnect via
 * the persisted encryption key (persistSession), never a re-mint.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import packageJson from '../../package.json';
import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata, Session as ApiSession } from '@/api/types';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import { persistSession, readPersistedSessions, type PersistedSession } from '@/persistence';
import { getProjectPath } from '@/claude/utils/path';
import type { RawJSONLines } from '@/claude/types';
import type { TerminalListItem } from '@/terminal/webTerminal';
import {
    parseTerminalHookPayload,
    decideMirrorBinding,
    mirrorLineKey,
    mirrorLocalId,
    MIRROR_BACKFILL_LINES_DEFAULT,
    type TerminalHookEvent,
} from './mirrorProtocol';
import { createMirrorScanner, type MirrorScanner } from './mirrorScanner';
import {
    pendingCreateAfterFailure,
    pendingCreateSupersededBy,
    planPendingCreate,
    type PendingMirrorCreate,
} from './mirrorPendingCreate';
import { scrubTmuxClientEnv, tmuxArgs } from '@/terminal/tmuxSocket';

export const TERMINAL_MIRROR_FLAVOR = 'terminal-mirror';

interface MirrorBinding {
    terminalId: string;
    happySessionId: string;
    claudeSessionId: string;
    status: 'active' | 'ended';
    client: ApiSessionClient;
    scanner: MirrorScanner | null;
    /** What persistSession needs on every metadata refresh. */
    persist: Omit<PersistedSession, 'metadata' | 'savedAt'>;
    metadata: Metadata;
    /** design v3 F4: a reactivate (unarchive) round-trip failed — retry it on a
     *  later reconcile tick, even while active, until the server tombstone clears
     *  (else the web keeps hiding the toggle behind archivedAt). */
    needsReactivate?: boolean;
}

/** design v3 E: after an end, don't let a stale claude footer lingering in the
 *  pane tail immediately re-adopt the just-ended session (toggle flicker). */
const RECONCILE_HYSTERESIS_MS = 20_000;

export interface MirrorManager {
    /** Raw /terminal-hook payload from the forwarder. Never throws. */
    handleHookPayload(body: unknown): void;
    /** Terminal disappeared from tmux (closed) — archive + tear down its mirror. */
    onTerminalClosed(terminalId: string): void;
    /** Every terminal-list push: detect claude exits the SessionEnd hook missed
     *  (pane_current_command back to a shell). */
    observeTerminalList(list: TerminalListItem[]): void;
    /** Shadow session id for a terminal (active or ended) — feeds the
     *  webTerminals push + closed-terminal records. */
    resolveMirrorSessionId(terminalId: string): string | undefined;
    /** B-107 hard guard for mirror-terminal-send: only a terminal whose
     *  mirror binding is ACTIVE (claude verifiably running) may receive
     *  pasted input — after claude exits the same bytes would execute in a
     *  bare shell. */
    isMirrorInputAllowed(terminalId: string): boolean;
    /** Rebuild bindings for still-alive terminals after a daemon restart. */
    restore(): Promise<void>;
    /** design v3: every list-track tick (signature-independent). Reconciles
     *  bindings to observed pane truth — re-adopts/reactivates a terminal whose
     *  claude is verifiably running but whose binding was lost/ended, ends one
     *  whose pane returned to a shell. Self-heals hook misses + restart orphans. */
    reconcile(list: TerminalListItem[]): void;
    /** Daemon shutdown: flush + close clients WITHOUT archiving (a restart
     *  must be able to pick the mirrors back up). */
    shutdown(): Promise<void>;
}

export function createMirrorManager(deps: {
    api: ApiClient;
    machineId: string;
    backfillLines?: number;
    /** Injectable for tests; defaults to a `tmux has-session` probe. */
    isTerminalAlive?: (terminalId: string) => boolean;
    /** A binding was created/ended/torn down — nudge the terminal-list push so
     *  the web learns about the toggle without waiting for the next tick. */
    onBindingsChanged?: () => void;
}): MirrorManager {
    const backfillLines = deps.backfillLines ?? MIRROR_BACKFILL_LINES_DEFAULT;
    const bindings = new Map<string, MirrorBinding>();
    // design v3 E: terminalId → last end time, for reconcile hysteresis.
    const lastEndedAt = new Map<string, number>();
    // B-304: terminalId → a SessionStart whose createBinding failed, awaiting a
    // retry on a reconcile tick. See mirrorPendingCreate.ts for why.
    const pendingCreates = new Map<string, PendingMirrorCreate>();
    // Hooks are rare and ordering matters (SessionEnd → SessionStart on
    // /clear); one global chain serializes all mutations.
    let chain: Promise<void> = Promise.resolve();

    /** design v3 F4: clear the server archive tombstone so the web stops hiding
     *  the session behind archivedAt. On failure mark for retry (reconcile
     *  re-issues it on later ticks until it sticks). */
    const reactivate = async (binding: MirrorBinding): Promise<void> => {
        try {
            const ok = await deps.api.reactivateSession(binding.happySessionId);
            binding.needsReactivate = !ok;
        } catch {
            binding.needsReactivate = true;
        }
    };

    const isTerminalAlive = deps.isTerminalAlive ?? ((terminalId: string): boolean => {
        try {
            return spawnSync('tmux', tmuxArgs(['has-session', '-t', `=vh-${terminalId}:`]), { stdio: 'ignore', timeout: 3000, env: scrubTmuxClientEnv({ ...process.env }) }).status === 0;
        } catch {
            return false;
        }
    });

    const transcriptPathFor = (event: { transcriptPath?: string; cwd?: string; claudeSessionId: string }): string | null => {
        if (event.transcriptPath) return event.transcriptPath;
        if (!event.cwd) return null;
        return join(getProjectPath(event.cwd), `${event.claudeSessionId}.jsonl`);
    };

    const persistBinding = (binding: MirrorBinding): void => {
        persistSession(binding.happySessionId, {
            ...binding.persist,
            metadata: binding.metadata,
            savedAt: Date.now(),
        });
    };

    const updateBindingMetadata = (binding: MirrorBinding, patch: Partial<Metadata>): void => {
        binding.metadata = { ...binding.metadata, ...patch };
        binding.client.updateMetadata((current) => ({ ...current, ...patch }));
        persistBinding(binding);
    };

    const sendMessages = (binding: MirrorBinding, messages: RawJSONLines[]): void => {
        for (const message of messages) {
            const key = mirrorLineKey(message);
            binding.client.sendClaudeSessionMessage(message, key
                ? { localIdFor: (envelopeIndex) => mirrorLocalId(key, envelopeIndex) }
                : undefined);
        }
    };

    const attachScanner = (binding: MirrorBinding, opts: { withTruncationNotice: boolean }): MirrorScanner => {
        const scanner = createMirrorScanner({
            backfillLines,
            events: {
                onMessages: (messages) => sendMessages(binding, messages),
                onBackfillTruncated: opts.withTruncationNotice
                    ? () => binding.client.sendSessionEvent({
                        type: 'message',
                        message: `只读镜像只回灌了最近 ${backfillLines} 条，更早内容请在终端里回看`,
                    })
                    : undefined,
                onFileGaveUp: () => {
                    logger.debug(`[MIRROR] transcript never appeared for terminal ${binding.terminalId} — ending binding`);
                    void endBinding(binding, 'transcript never appeared');
                },
            },
        });
        binding.scanner = scanner;
        return scanner;
    };

    const endBinding = async (binding: MirrorBinding, reason: string): Promise<void> => {
        if (binding.status === 'ended') return;
        binding.status = 'ended';
        // Hysteresis anchor + drop any pending reactivate (the session is now
        // deactivated on purpose; a later revival will re-issue unarchive).
        lastEndedAt.set(binding.terminalId, Date.now());
        binding.needsReactivate = false;
        logger.debug(`[MIRROR] ending binding for terminal ${binding.terminalId} (${reason})`);
        await binding.scanner?.cleanup();
        binding.scanner = null;
        binding.client.closeClaudeSessionTurn('completed');
        updateBindingMetadata(binding, {
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: TERMINAL_MIRROR_FLAVOR,
            archiveReason: reason,
        });
        try {
            await deps.api.deactivateSession(binding.happySessionId);
        } catch (error) {
            logger.debug(`[MIRROR] deactivateSession failed for ${binding.happySessionId}:`, error);
        }
        deps.onBindingsChanged?.();
    };

    const teardownBinding = async (binding: MirrorBinding, reason: string): Promise<void> => {
        await endBinding(binding, reason);
        bindings.delete(binding.terminalId);
        deps.onBindingsChanged?.();
        try {
            await binding.client.flush();
        } catch { /* best-effort */ }
        await binding.client.close();
    };

    // design v3: re-adopt a terminal's mirror from its NEWEST persisted record
    // (post-restart, when restore() skipped it because it was archived). Same
    // reconnect-via-persisted-key path as restore() (B-051: never re-mints a
    // tag). Keeps restore's flavor + machineId + claudeSessionId filters — this
    // opens a live client + the B-107 input gate, so it must be at least as
    // strict as restore.
    const adoptPersisted = async (terminalId: string, persisted: Record<string, PersistedSession>): Promise<void> => {
        if (bindings.has(terminalId)) return;
        let best: { sessionId: string; entry: PersistedSession } | null = null;
        for (const [sessionId, entry] of Object.entries(persisted)) {
            const meta = entry.metadata;
            if (meta?.flavor !== TERMINAL_MIRROR_FLAVOR) continue;
            if (meta.machineId !== deps.machineId) continue;
            if ((meta as Metadata).terminalId !== terminalId) continue;
            if (!meta.claudeSessionId) continue;
            if (!best || entry.savedAt > best.entry.savedAt) best = { sessionId, entry };
        }
        if (!best) return;
        const { sessionId, entry } = best;
        const meta = entry.metadata;
        const session: ApiSession = {
            id: sessionId,
            seq: entry.seq,
            metadata: meta,
            metadataVersion: entry.metadataVersion,
            agentState: null,
            agentStateVersion: entry.agentStateVersion,
            encryptionKey: decodeBase64(entry.encryptionKey),
            encryptionVariant: entry.encryptionVariant,
        };
        const client = deps.api.sessionSyncClient(session);
        client.skipExistingMessages();
        const binding: MirrorBinding = {
            terminalId,
            happySessionId: sessionId,
            claudeSessionId: meta.claudeSessionId!,
            status: 'active',
            client,
            scanner: null,
            persist: {
                encryptionKey: entry.encryptionKey,
                encryptionVariant: entry.encryptionVariant,
                seq: entry.seq,
                metadataVersion: entry.metadataVersion,
                agentStateVersion: entry.agentStateVersion,
            },
            metadata: meta,
        };
        bindings.set(terminalId, binding);
        await reactivate(binding);
        updateBindingMetadata(binding, {
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
            archivedBy: undefined,
            archiveReason: undefined,
        });
        const scanner = attachScanner(binding, { withTruncationNotice: false });
        scanner.addFile(join(getProjectPath(meta.path), `${meta.claudeSessionId}.jsonl`), 'backfill-tail');
        logger.debug(`[MIRROR] reconcile adopted terminal ${terminalId} → ${sessionId}`);
        deps.onBindingsChanged?.();
    };

    // design v3: re-activate an ended-but-still-in-map binding whose pane is
    // observably running claude again (SessionEnd fired while claude kept
    // running). Reuses the SAME open client — endBinding never closes it, only
    // teardownBinding does — so no second client (Round-2 double-client guard).
    // backfill-tail, NOT from-eof: it is the SAME session's file, grown since
    // the scanner was cleaned up; from-eof would drop the gap-window lines.
    const reactivateInPlace = async (binding: MirrorBinding): Promise<void> => {
        if (binding.status !== 'ended') return;
        binding.status = 'active';
        await reactivate(binding);
        updateBindingMetadata(binding, {
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
            archivedBy: undefined,
            archiveReason: undefined,
        });
        const scanner = binding.scanner ?? attachScanner(binding, { withTruncationNotice: false });
        scanner.addFile(join(getProjectPath(binding.metadata.path), `${binding.claudeSessionId}.jsonl`), 'backfill-tail');
        logger.debug(`[MIRROR] reconcile reactivated (in place) terminal ${binding.terminalId}`);
        deps.onBindingsChanged?.();
    };

    /** B-304: remember a failed create so a reconcile tick can retry it. */
    const parkFailedCreate = (event: TerminalHookEvent, reason: unknown): void => {
        const pending = pendingCreateAfterFailure(pendingCreates.get(event.terminalId), event, Date.now());
        pendingCreates.set(event.terminalId, pending);
        logger.debug(
            `[MIRROR] mirror bind failed for terminal ${event.terminalId} (attempt ${pending.attempts}, retrying):`,
            reason,
        );
    };

    const createBinding = async (event: TerminalHookEvent, replaces?: MirrorBinding): Promise<void> => {
        if (replaces) {
            await teardownBinding(replaces, 'superseded by a fresh conversation');
        }
        const metadata: Metadata = {
            path: event.cwd ?? os.homedir(),
            host: os.hostname(),
            version: packageJson.version,
            os: os.platform(),
            machineId: deps.machineId,
            homeDir: os.homedir(),
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: projectPath(),
            happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
            startedBy: 'terminal',
            lifecycleState: 'running',
            lifecycleStateSince: Date.now(),
            flavor: TERMINAL_MIRROR_FLAVOR,
            terminalId: event.terminalId,
            claudeSessionId: event.claudeSessionId,
        };
        // Random tag ALWAYS (B-051 tombstone: a fixed tag + fresh key mint =
        // undecryptable rows).
        // B-304: a create that fails here used to be the end of it — the hook is
        // a one-shot event, and reconcile's adoptPersisted can only revive a
        // record a SUCCESSFUL create left behind. Both failure shapes (null for
        // 5xx/404, throw for 4xx such as the account-wide 429 write-rate bucket)
        // now park the event for a retry on the next reconcile tick.
        let response: ApiSession | null = null;
        try {
            response = await deps.api.getOrCreateSession({ tag: randomUUID(), metadata, state: {} });
        } catch (error) {
            parkFailedCreate(event, error);
            return;
        }
        if (!response) {
            parkFailedCreate(event, 'server unreachable');
            return;
        }
        pendingCreates.delete(event.terminalId);
        const client = deps.api.sessionSyncClient(response);
        client.skipExistingMessages();
        const binding: MirrorBinding = {
            terminalId: event.terminalId,
            happySessionId: response.id,
            claudeSessionId: event.claudeSessionId,
            status: 'active',
            client,
            scanner: null,
            persist: {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            },
            metadata,
        };
        bindings.set(event.terminalId, binding);
        persistBinding(binding);
        deps.onBindingsChanged?.();

        const scanner = attachScanner(binding, { withTruncationNotice: true });
        const transcript = transcriptPathFor(event);
        if (transcript) {
            scanner.addFile(transcript, 'backfill-tail');
        } else {
            logger.debug(`[MIRROR] hook carried no transcript path and no cwd for terminal ${event.terminalId}`);
        }
        logger.debug(`[MIRROR] bound terminal ${event.terminalId} → shadow session ${response.id} (claude ${event.claudeSessionId})`);
    };

    const continueBinding = async (binding: MirrorBinding, event: TerminalHookEvent): Promise<void> => {
        binding.claudeSessionId = event.claudeSessionId;
        if (binding.status === 'ended') {
            binding.status = 'active';
            // F4: endBinding deactivated the server session; a continue must
            // clear that archive tombstone or the web keeps the toggle hidden.
            await reactivate(binding);
            updateBindingMetadata(binding, {
                lifecycleState: 'running',
                lifecycleStateSince: Date.now(),
                archivedBy: undefined,
                archiveReason: undefined,
                claudeSessionId: event.claudeSessionId,
                ...(event.cwd ? { path: event.cwd } : {}),
            });
        } else {
            updateBindingMetadata(binding, {
                claudeSessionId: event.claudeSessionId,
                ...(event.cwd ? { path: event.cwd } : {}),
            });
        }
        // The continuation file's history prefix is server-known by
        // construction (spec M4②) — follow it from EOF; NEVER rely on the
        // uuid dedupe set (truncated backfill would replay ancient history).
        const scanner = binding.scanner ?? attachScanner(binding, { withTruncationNotice: false });
        const transcript = transcriptPathFor(event);
        if (transcript) scanner.addFile(transcript, 'from-eof');
        logger.debug(`[MIRROR] terminal ${binding.terminalId} mirror continues as claude ${event.claudeSessionId}`);
    };

    const handleEvent = async (event: TerminalHookEvent): Promise<void> => {
        // B-304: a fresh hook for this terminal is newer truth than a parked
        // create — a SessionStart re-parks itself if it fails again, and a
        // SessionEnd for the same claude session means it is gone.
        const parked = pendingCreates.get(event.terminalId);
        if (parked && pendingCreateSupersededBy(parked, event)) pendingCreates.delete(event.terminalId);
        const binding = bindings.get(event.terminalId) ?? null;
        const decision = decideMirrorBinding(
            event,
            binding ? { status: binding.status, claudeSessionId: binding.claudeSessionId } : null,
        );
        switch (decision.action) {
            case 'create':
                await createBinding(event, decision.replaces ? binding ?? undefined : undefined);
                return;
            case 'continue':
                await continueBinding(binding!, event);
                return;
            case 'end':
                await endBinding(binding!, 'claude exited (SessionEnd hook)');
                return;
            case 'ignore':
                logger.debug(`[MIRROR] ignoring ${event.event} for terminal ${event.terminalId}: ${decision.reason}`);
                return;
        }
    };

    return {
        handleHookPayload(body: unknown): void {
            const event = parseTerminalHookPayload(body);
            if (!event) {
                logger.debug('[MIRROR] unparseable /terminal-hook payload dropped');
                return;
            }
            chain = chain.then(() => handleEvent(event)).catch((error) => {
                logger.debug(`[MIRROR] hook handling failed for terminal ${event.terminalId}:`, error);
            });
        },

        onTerminalClosed(terminalId: string): void {
            pendingCreates.delete(terminalId);
            const binding = bindings.get(terminalId);
            if (!binding) return;
            chain = chain.then(() => teardownBinding(binding, 'terminal closed')).catch((error) => {
                logger.debug(`[MIRROR] teardown failed for terminal ${terminalId}:`, error);
            });
        },

        observeTerminalList(list: TerminalListItem[]): void {
            for (const item of list) {
                const binding = bindings.get(item.id);
                if (!binding || binding.status !== 'active') continue;
                // pane_current_command back to a plain shell = claude is gone
                // and the SessionEnd hook never reached us (kill -9, crash).
                if (item.agentState === 'shell') {
                    chain = chain.then(() => endBinding(binding, 'claude exited (pane observation)')).catch((error) => {
                        logger.debug(`[MIRROR] pane-exit end failed for terminal ${item.id}:`, error);
                    });
                }
            }
        },

        reconcile(list: TerminalListItem[]): void {
            let persisted: Record<string, PersistedSession> | null = null;
            const now = Date.now();
            for (const item of list) {
                const binding = bindings.get(item.id) ?? null;
                // Pane back to a shell → end an active binding (pane observation
                // safety net, same as observeTerminalList).
                if (item.agentState === 'shell') {
                    // B-304: claude is gone — a parked create for it is dead.
                    pendingCreates.delete(item.id);
                    if (binding && binding.status === 'active') {
                        chain = chain.then(() => {
                            const b = bindings.get(item.id);
                            return b && b.status === 'active' ? endBinding(b, 'claude exited (pane observation)') : undefined;
                        }).catch((e) => logger.debug(`[MIRROR] reconcile end failed for ${item.id}:`, e));
                    }
                    continue;
                }
                // Retry a pending unarchive on an already-active binding (F4).
                if (binding && binding.status === 'active' && binding.needsReactivate) {
                    chain = chain.then(() => {
                        const b = bindings.get(item.id);
                        return b && b.status === 'active' && b.needsReactivate ? reactivate(b) : undefined;
                    }).catch((e) => logger.debug(`[MIRROR] reconcile reactivate-retry failed for ${item.id}:`, e));
                }
                // Adopt / reactivate ONLY on claude-confident evidence (a bare
                // `node` classifies as agentState 'idle' but is NOT confident —
                // reactivating it would re-open the B-107 input gate on node).
                if (!item.claudeConfident) continue;
                const endedAt = lastEndedAt.get(item.id);
                if (endedAt !== undefined && now - endedAt < RECONCILE_HYSTERESIS_MS) continue; // hysteresis
                if (binding && binding.status === 'ended') {
                    chain = chain.then(() => {
                        const b = bindings.get(item.id);
                        return b && b.status === 'ended' ? reactivateInPlace(b) : undefined;
                    }).catch((e) => logger.debug(`[MIRROR] reconcile in-place reactivate failed for ${item.id}:`, e));
                } else if (!binding) {
                    // B-304: a parked create outranks adoptPersisted — it names
                    // the claude session running RIGHT NOW, while the newest
                    // persisted record is by definition an older conversation.
                    const pending = pendingCreates.get(item.id);
                    if (pending) {
                        const decision = planPendingCreate(pending, now);
                        if (decision === 'drop') {
                            pendingCreates.delete(item.id);
                            logger.debug(`[MIRROR] giving up on the parked mirror bind for terminal ${item.id}`);
                        } else if (decision === 'retry') {
                            chain = chain.then(() => {
                                // Re-read: a real hook may have landed while we queued.
                                const still = pendingCreates.get(item.id);
                                if (!still || still !== pending || bindings.has(item.id)) return undefined;
                                return createBinding(still.event);
                            }).catch((e) => logger.debug(`[MIRROR] reconcile create retry failed for ${item.id}:`, e));
                        }
                        continue;
                    }
                    persisted ??= readPersistedSessions();
                    const p = persisted;
                    chain = chain.then(() => {
                        return bindings.has(item.id) ? undefined : adoptPersisted(item.id, p);
                    }).catch((e) => logger.debug(`[MIRROR] reconcile adopt failed for ${item.id}:`, e));
                }
            }
        },

        resolveMirrorSessionId(terminalId: string): string | undefined {
            return bindings.get(terminalId)?.happySessionId;
        },

        isMirrorInputAllowed(terminalId: string): boolean {
            return bindings.get(terminalId)?.status === 'active';
        },

        async restore(): Promise<void> {
            const persisted = readPersistedSessions();
            for (const [sessionId, entry] of Object.entries(persisted)) {
                const meta = entry.metadata;
                if (meta?.flavor !== TERMINAL_MIRROR_FLAVOR) continue;
                if (meta.machineId !== deps.machineId) continue;
                const terminalId = (meta as Metadata).terminalId;
                if (!terminalId || bindings.has(terminalId)) continue;
                if (meta.lifecycleState !== 'running') continue;
                if (!isTerminalAlive(terminalId)) continue;
                if (!meta.claudeSessionId) continue;

                const session: ApiSession = {
                    id: sessionId,
                    seq: entry.seq,
                    metadata: meta,
                    metadataVersion: entry.metadataVersion,
                    agentState: null,
                    agentStateVersion: entry.agentStateVersion,
                    encryptionKey: decodeBase64(entry.encryptionKey),
                    encryptionVariant: entry.encryptionVariant,
                };
                const client = deps.api.sessionSyncClient(session);
                client.skipExistingMessages();
                const binding: MirrorBinding = {
                    terminalId,
                    happySessionId: sessionId,
                    claudeSessionId: meta.claudeSessionId,
                    status: 'active',
                    client,
                    scanner: null,
                    persist: {
                        encryptionKey: entry.encryptionKey,
                        encryptionVariant: entry.encryptionVariant,
                        seq: entry.seq,
                        metadataVersion: entry.metadataVersion,
                        agentStateVersion: entry.agentStateVersion,
                    },
                    metadata: meta,
                };
                bindings.set(terminalId, binding);
                // MF-1: no offset persistence — replay the tail (localId
                // idempotency dedupes) so lines written while the daemon was
                // down are covered. No truncation notice on restores (it
                // would repeat on every restart of a long session).
                const scanner = attachScanner(binding, { withTruncationNotice: false });
                scanner.addFile(join(getProjectPath(meta.path), `${meta.claudeSessionId}.jsonl`), 'backfill-tail');
                logger.debug(`[MIRROR] restored binding terminal ${terminalId} → ${sessionId}`);
                deps.onBindingsChanged?.();
            }
        },

        async shutdown(): Promise<void> {
            await chain.catch(() => { /* drained */ });
            for (const binding of bindings.values()) {
                await binding.scanner?.cleanup();
                try {
                    await binding.client.flush();
                } catch { /* best-effort */ }
                await binding.client.close();
            }
            bindings.clear();
        },
    };
}
