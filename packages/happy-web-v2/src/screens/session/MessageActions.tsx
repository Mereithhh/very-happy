import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@/sync/storageTypes';
import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Pencil, Quote, X } from 'lucide-react';
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

export function MessageActions({ text, sessionId, userMessage, hasAttachments = false }: {
    text: string; sessionId: string; userMessage?: UserTextMessage; hasAttachments?: boolean;
}) {
    const { t, lang } = useTranslation();
    const copy = messageActionsCopy(lang);
    const session = storage(useShallow((state) => {
        const current = userMessage ? state.sessions[sessionId] : undefined;
        return current ? { id: current.id, metadata: current.metadata, permissionMode: current.permissionMode, presence: current.presence, thinking: current.thinking } as Session : null;
    }));
    const running = isAgentWorkLive({ presence: session?.presence, thinking: session?.thinking, heartbeatFresh: isHeartbeatFresh(sessionId), runningSubagentsInTurn: 0 });
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const [edited, setEdited] = useState(text);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const loadedSource = useRef<string | null>(null);
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
    const openEditor = async () => {
        setOpen(true);
        if (attempted || loadingPoints || points) return;
        setEdited(text);
        if (unavailable || !source) return;
        setLoadingPoints(true);
        setError(null);
        try {
            const response = await apiSocket.machineRPC<unknown, Record<string, string>>(source.machineId,
                source.kind === 'claude' ? 'claude-list-rewind-points' : 'codex-list-rewind-points',
                source.kind === 'claude' ? { directory: source.directory, claudeSessionId: source.claudeSessionId } : { directory: source.directory, codexThreadId: source.codexThreadId });
            const result = response as { type?: string; error?: string; errorMessage?: string; points?: Array<{ uuid?: string; itemId?: string; text: string; timestamp: number; hasAttachments?: boolean }> };
            if (!result || result.error || result.type !== 'success' || !Array.isArray(result.points)) throw new Error(result?.error || result?.errorMessage || 'Invalid history response');
            const loaded = result.points.flatMap((p) => {
                const id = source.kind === 'claude' ? p.uuid : p.itemId;
                return typeof id === 'string' && typeof p.text === 'string' ? [{ id, text: p.text, timestamp: p.timestamp, hasAttachments: p.hasAttachments }] : [];
            });
            loadedSource.current = JSON.stringify(source);
            setPoints(loaded);
            // Exact ID verification only. Missing/legacy synthetic IDs require explicit selection.
            if (typeof target !== 'string' && loaded.some((p) => p.id === target.pointId && !p.hasAttachments)) setSelectedPoint(target.pointId);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : copy.empty);
        } finally { setLoadingPoints(false); }
    };
    const submit = async () => {
        if (busyRef.current || attempted || !edited.trim() || unavailable || !source || !selectedPoint) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        let created: string | null = null;
        let mutationStarted = false;
        try {
            // Re-read source state at submission, not just when the dialog opened.
            const current = storage.getState().sessions[sessionId];
            const checked = getRewindTarget(current, userMessage!, hasAttachments, isAgentWorkLive({ presence: current?.presence, thinking: current?.thinking, heartbeatFresh: isHeartbeatFresh(sessionId), runningSubagentsInTurn: 0 }));
            if (typeof checked === 'string' && checked !== 'missingPoint') throw new Error(copy[checked]);
            const currentSource = current ? getSessionForkSource(current) : null;
            if (!currentSource || JSON.stringify(currentSource) !== loadedSource.current) {
                setPoints(null); setSelectedPoint(null); loadedSource.current = null;
                throw new Error('Source session changed; reopen the editor');
            }
            const permissionMode = rewindPermissionMode(source.kind, current?.permissionMode ?? current?.metadata?.permissionMode);
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
        <div className="msg-actions" role="group" aria-label={copy.actions}>
            <CopyButton text={text} showLabel label={t('message.copyMessage')} />
            <button type="button" className="msg-action" onClick={() => quoteMessage(sessionId, text)}><Quote size={14} aria-hidden /><span>{copy.quote}</span></button>
            {userMessage && <button type="button" className="msg-action" onClick={() => void openEditor()}><Pencil size={14} aria-hidden /><span>{copy.edit}</span></button>}
        </div>
        {userMessage && <Dialog.Root open={open} onOpenChange={(next) => { if (!busyRef.current) setOpen(next); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="msg-edit-overlay" />
                <Dialog.Content className="msg-edit-dialog">
                    <div className="msg-edit-head">
                        <Dialog.Title>{copy.title}</Dialog.Title>
                        <Dialog.Close asChild><button className="msg-action" type="button" disabled={busy} aria-label={copy.cancel}><X size={18} /></button></Dialog.Close>
                    </div>
                    <Dialog.Description className="msg-edit-description">{copy.description}</Dialog.Description>
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
                    {!unavailable && selectedPoint && !attempted && <button className="msg-action" type="button" onClick={() => setSelectedPoint(null)}>{copy.choose}</button>}
                    {unavailable ? <p className="msg-edit-description" role="status">{copy[unavailable]}</p> : selectedPoint && <label className="msg-edit-label">
                        {copy.text}
                        <textarea autoFocus value={edited} disabled={busy || attempted} onChange={(e) => setEdited(e.target.value)} />
                    </label>}
                    {error && <p role="alert" className="msg-edit-error">{error}</p>}
                    <div className="msg-edit-footer">
                        <Button onClick={() => setOpen(false)} disabled={busy}>{copy.cancel}</Button>
                        {branchId ? <Button variant="primary" disabled={busy} onClick={() => { storage.getState().updateSessionDraft(branchId, edited); navigate(`/session/${branchId}`); }}>{copy.open}</Button>
                            : !unavailable && <Button variant="primary" loading={busy} disabled={!edited.trim() || attempted || !selectedPoint || loadingPoints} onClick={() => void submit()}>{busy ? copy.busy : copy.submit}</Button>}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>}
    </>;
}
