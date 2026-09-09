import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@/sync/storageTypes';
import { useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Pencil, Quote, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { CopyButton } from '@/ui/CopyButton';
import { Button } from '@/ui/Button';
import { toast } from '@/ui/Toast';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { apiSocket } from '@/sync/apiSocket';
import { machineSpawnNewSession } from '@/sync/ops';
import type { UserTextMessage } from '@/sync/typesMessage';
import { getSessionForkSource } from '@/utils/sessionFork';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { isHeartbeatFresh } from '@/sync/heartbeatLease';
import { getRewindTarget, rewindPermissionMode } from './messageActionsModel';
import { createRewindBranch } from './rewindOperation';
import { quoteMessage } from './messageQuote';
import { messageActionsCopy } from './messageActionsCopy';
import './messageActions.css';

export function MessageActions({ text, sessionId, userMessage, hasAttachments = false, children }: {
    text: string; sessionId: string; userMessage?: UserTextMessage; hasAttachments?: boolean; children?: ReactNode;
}) {
    const { t, lang } = useTranslation();
    const copy = messageActionsCopy(lang);
    const session = storage(useShallow((state) => {
        const current = userMessage ? state.sessions[sessionId] : undefined;
        return current ? { id: current.id, metadata: current.metadata, permissionMode: current.permissionMode, presence: current.presence, thinking: current.thinking } as Session : null;
    }));
    const running = isAgentWorkLive({ presence: session?.presence, thinking: session?.thinking, heartbeatFresh: isHeartbeatFresh(sessionId), runningSubagentsInTurn: 0 });
    const navigate = useNavigate();
    const editId = useId();
    const editButton = useRef<HTMLButtonElement>(null);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [open, setOpen] = useState(false);
    const [edited, setEdited] = useState(text);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const loadedSource = useRef<string | null>(null);
    const historyRequest = useRef(0);
    const [error, setError] = useState<string | null>(null);
    const [branchId, setBranchId] = useState<string | null>(null);
    // A failed mutating RPC may have succeeded remotely. Never automatically replay it.
    const [attempted, setAttempted] = useState(false);
    const [points, setPoints] = useState<Array<{ id: string; text: string; timestamp: number; hasAttachments?: boolean }> | null>(null);
    const [selectedPoint, setSelectedPoint] = useState<string | null>(null);
    const [loadingPoints, setLoadingPoints] = useState(false);
    const source = session ? getSessionForkSource(session) : null;
    const target = userMessage ? getRewindTarget(session, userMessage, hasAttachments, running) : 'unsupported';
    const unavailable = typeof target === 'string' && target !== 'missingPoint' ? target : null;
    const closeEditor = () => {
        if (busyRef.current) return;
        historyRequest.current += 1;
        setLoadingPoints(false);
        setActionsOpen(true);
        setOpen(false);
        requestAnimationFrame(() => editButton.current?.focus());
    };
    const openEditor = async () => {
        setActionsOpen(false);
        setOpen(true);
        if (attempted) return;
        const request = ++historyRequest.current;
        setPoints(null);
        setSelectedPoint(null);
        setError(null);
        setEdited(text);
        if (unavailable || !source) return;
        loadedSource.current = JSON.stringify(source);
        if (typeof target !== 'string') {
            setSelectedPoint(target.pointId);
            return;
        }
        setLoadingPoints(true);
        setError(null);
        try {
            const response = await apiSocket.machineRPC<unknown, Record<string, string>>(source.machineId,
                source.kind === 'claude' ? 'claude-list-rewind-points' : 'codex-list-rewind-points',
                source.kind === 'claude' ? { directory: source.directory, claudeSessionId: source.claudeSessionId } : { directory: source.directory, codexThreadId: source.codexThreadId });
            if (request !== historyRequest.current) return;
            const result = response as { type?: string; error?: string; errorMessage?: string; points?: Array<{ uuid?: string; itemId?: string; text: string; timestamp: number; hasAttachments?: boolean }> };
            if (!result || result.error || result.type !== 'success' || !Array.isArray(result.points)) throw new Error(result?.error || result?.errorMessage || 'Invalid history response');
            const loaded = result.points.flatMap((p) => {
                const id = source.kind === 'claude' ? p.uuid : p.itemId;
                return typeof id === 'string' && typeof p.text === 'string' ? [{ id, text: p.text, timestamp: p.timestamp, hasAttachments: p.hasAttachments }] : [];
            });
            loadedSource.current = JSON.stringify(source);
            setPoints(loaded);
            // Legacy IDs require explicit selection; never infer from matching text.
        } catch (cause) {
            if (request === historyRequest.current) setError(cause instanceof Error ? cause.message : copy.empty);
        } finally { if (request === historyRequest.current) setLoadingPoints(false); }
    };
    const submit = async () => {
        if (busyRef.current || attempted || !edited.trim() || unavailable || !source || !selectedPoint) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        let created: string | null = null;
        let mutationStarted = false;
        try {
            // Re-read source state at submission, not just when the editor opened.
            const current = storage.getState().sessions[sessionId];
            const checked = getRewindTarget(current, userMessage!, hasAttachments, isAgentWorkLive({ presence: current?.presence, thinking: current?.thinking, heartbeatFresh: isHeartbeatFresh(sessionId), runningSubagentsInTurn: 0 }));
            if (typeof checked === 'string' && checked !== 'missingPoint') throw new Error(copy[checked]);
            const currentSource = current ? getSessionForkSource(current) : null;
            if (!currentSource || JSON.stringify(currentSource) !== loadedSource.current) {
                setPoints(null); setSelectedPoint(null); loadedSource.current = null;
                throw new Error(copy.sourceChanged);
            }
            // Let the user type immediately; validate the exact point before any write.
            const history = await apiSocket.machineRPC<unknown, Record<string, string>>(source.machineId,
                source.kind === 'claude' ? 'claude-list-rewind-points' : 'codex-list-rewind-points',
                source.kind === 'claude' ? { directory: source.directory, claudeSessionId: source.claudeSessionId } : { directory: source.directory, codexThreadId: source.codexThreadId });
            const historyResult = history as { type?: string; error?: string; points?: Array<{ uuid?: string; itemId?: string; hasAttachments?: boolean }> } | null;
            if (!historyResult || historyResult.error || historyResult.type !== 'success' || !Array.isArray(historyResult.points)) throw new Error(historyResult?.error || copy.missingPoint);
            if (!historyResult.points.some(p => (source.kind === 'claude' ? p.uuid : p.itemId) === selectedPoint && !p.hasAttachments)) throw new Error(copy.missingPoint);
            const latest = storage.getState().sessions[sessionId];
            const latestTarget = getRewindTarget(latest, userMessage!, hasAttachments, isAgentWorkLive({ presence: latest?.presence, thinking: latest?.thinking, heartbeatFresh: isHeartbeatFresh(sessionId), runningSubagentsInTurn: 0 }));
            if (typeof latestTarget === 'string' && latestTarget !== 'missingPoint') throw new Error(copy[latestTarget]);
            if (JSON.stringify(latest ? getSessionForkSource(latest) : null) !== loadedSource.current) throw new Error(copy.sourceChanged);
            const permissionMode = rewindPermissionMode(source.kind, latest?.permissionMode ?? latest?.metadata?.permissionMode);
            mutationStarted = true;
            setAttempted(true);
            created = await createRewindBranch({ source, messageId: typeof target !== 'string' && target.pointId === selectedPoint ? userMessage!.id : undefined, pointId: selectedPoint }, permissionMode, {
                rpc: (machineId, method, args) => apiSocket.machineRPC(machineId, method, args),
                spawn: machineSpawnNewSession,
                rememberMode: (id, mode) => storage.getState().updateSessionPermissionMode(id, mode),
            });
            setBranchId(created);
            // Store owns drafts even before the branch snapshot arrives.
            storage.getState().updateSessionDraft(created, edited);
            await sync.refreshSessions();
            if (!storage.getState().sessions[created]) throw new Error('Branch is still syncing');
            storage.getState().updateSessionDraft(created, edited);
            if (current?.modelMode != null) storage.getState().updateSessionModelMode(created, current.modelMode);
            if (current?.effortLevel != null) storage.getState().updateSessionEffortLevel(created, current.effortLevel);
            const receipt = await sync.sendMessage(created, edited, { source: 'chat' });
            if (!receipt) throw new Error('Message was not queued');
            storage.getState().updateSessionDraft(created, null);
            toast.success(copy.queued);
            navigate(`/session/${created}`);
        } catch (cause) {
            const detail = cause instanceof Error ? cause.message : '';
            const oldDaemon = /method.*not.*found|unknown.*method|not registered/i.test(detail);
            if (oldDaemon) setAttempted(false); // Explicit rejection: no mutation took place.
            setError(created ? copy.sendFailed : oldDaemon ? copy.oldDaemon : !mutationStarted ? detail : `${copy.failed}${detail ? ` (${detail})` : ''}`);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    return <>
        {(!open || unavailable) && children}
        {!open && <div className={`msg-actions${actionsOpen ? ' is-open' : ''}`} role="group" aria-label={copy.actions}>
            <button type="button" className="msg-action msg-actions-more" aria-label={copy.actions} aria-expanded={actionsOpen} aria-controls={`${editId}-actions`} onClick={() => setActionsOpen(value => !value)}><MoreHorizontal size={18} aria-hidden /></button>
            <div className="msg-actions-items" id={`${editId}-actions`}>
                <CopyButton text={text} showLabel label={t('message.copyMessage')} />
                <button type="button" className="msg-action" onClick={() => { quoteMessage(sessionId, text); setActionsOpen(false); }}><Quote size={14} aria-hidden /><span>{copy.quote}</span></button>
                {userMessage && <button ref={editButton} type="button" className="msg-action" onClick={() => void openEditor()}><Pencil size={14} aria-hidden /><span>{copy.edit}</span></button>}
            </div>
        </div>}
        {userMessage && open && <section className="msg-edit-inline" aria-labelledby={editId} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); closeEditor(); }
        }}>
            <div className="msg-edit-head">
                <h2 id={editId}>{copy.title}</h2>
                <button className="msg-action" type="button" disabled={busy} aria-label={copy.cancel} onClick={closeEditor}><X size={18} /></button>
            </div>
            {!unavailable && selectedPoint && <label className="msg-edit-label">
                <span className="sr-only">{copy.text}</span>
                <textarea autoFocus value={edited} disabled={busy || attempted} onChange={(event) => setEdited(event.target.value)} />
            </label>}
            <p className="msg-edit-description">{copy.description}</p>
            {loadingPoints && <p role="status" className="msg-edit-description">{copy.loading}</p>}
            {!unavailable && !loadingPoints && !selectedPoint && points && <div className="msg-edit-points">
                <p className="msg-edit-description">{copy.chooseHint}</p>
                <label>{copy.choose}<select value="" onChange={(event) => {
                    const point = points.find((p) => p.id === event.target.value);
                    if (point && !point.hasAttachments) { setSelectedPoint(point.id); setEdited(point.text); }
                }}><option value="" disabled>{points.length ? copy.choose : copy.empty}</option>
                    {points.map((p, index) => <option key={p.id} value={p.id} disabled={p.hasAttachments}>{index + 1}. {p.text.slice(0, 120)}{p.hasAttachments ? ` — ${copy.attachments}` : ''}</option>)}
                </select></label>
            </div>}
            {unavailable && <p className="msg-edit-description" role="status">{copy[unavailable]}</p>}
            {error && <p role="alert" className="msg-edit-error">{error}</p>}
            <div className="msg-edit-footer">
                <Button onClick={closeEditor} disabled={busy}>{copy.cancel}</Button>
                {branchId ? <Button variant="primary" disabled={busy} onClick={() => { storage.getState().updateSessionDraft(branchId, edited); navigate(`/session/${branchId}`); }}>{copy.open}</Button>
                    : !unavailable && <Button variant="primary" loading={busy} disabled={!edited.trim() || attempted || !selectedPoint || loadingPoints} onClick={() => void submit()}>{busy ? copy.busy : copy.submit}</Button>}
            </div>
        </section>}
    </>;
}
