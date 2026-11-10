/**
 * useMainAgent — resolves THE main agent (B-916a) for every surface: sidebar
 * entry, drawer, /main-agent page, ⌘K, settings, and /assistant.
 *
 * Resolution is pure (`resolveMainAgent`); this hook only wires the synced
 * stores, refreshes the KV pointer, and exposes the spawn action. Spawning is
 * NEVER automatic for a fresh account: the user enables it on a machine
 * (`enable`). Only when the account already points at a machine whose
 * session is gone (`starting`) does the drawer re-spawn there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { storage, useAllMachines, useAllSessions, useSetting } from '@/sync/storage';
import { machineSpawnNewSession, sessionArchive } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { ASSISTANT_DIRECTORY } from './assistantConstants';
import { useAssistantStore } from './assistantStore';
import { MAIN_AGENT_OTHER_MACHINE_ERROR, resolveMainAgent, shouldWritePointerBeforeSpawn, type MainAgentState } from './mainAgent';
import { refreshMainAgentPointer, useMainAgentStore, writeMainAgentPointer } from './mainAgentStore';

/** Pointer refresh cadence while some surface is mounted (the daemon rewrites it on rotation). */
const POINTER_REFRESH_MS = 60_000;

/**
 * Keep the KV pointer fresh. Mount ONCE per shell (MainAgentHost in AppLayout;
 * the full-viewport /assistant screen mounts its own): every other surface
 * reads the store through useMainAgentState.
 */
export function useMainAgentPointerSync(): void {
    const { credentials } = useAuth();
    useEffect(() => {
        if (!credentials) return;
        void refreshMainAgentPointer(credentials);
        const id = window.setInterval(() => {
            if (document.visibilityState === 'visible') void refreshMainAgentPointer(credentials);
        }, POINTER_REFRESH_MS);
        return () => window.clearInterval(id);
    }, [credentials]);
}

export function useMainAgentState(): MainAgentState {
    const dataReady = storage((s) => s.isDataReady);
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const legacyMachineId = useSetting('assistantMachineId');
    const pointer = useMainAgentStore((s) => s.pointer);
    const pointerStatus = useMainAgentStore((s) => s.pointerStatus);

    return useMemo(
        () => (pointerStatus === 'idle' || pointerStatus === 'loading')
            ? { kind: 'loading' as const }
            : resolveMainAgent({ dataReady, sessions, machines, pointer, legacyMachineId }),
        [dataReady, sessions, machines, pointer, pointerStatus, legacyMachineId],
    );
}

export interface MainAgentActions {
    spawning: boolean;
    spawnError: string | null;
    /** enable (or move) the main agent on a machine: spawn, then point the account at it */
    enable: (machineId: string, opts?: { forceNew?: boolean }) => Promise<string | null>;
    /** new conversation / move: spawn fresh on `machineId`, then archive `previousId` once the new one exists */
    replace: (machineId: string, previousId: string | null) => Promise<string | null>;
}

export function useMainAgentActions(): MainAgentActions {
    const { credentials } = useAuth();
    const skipPermissions = useSetting('assistantSkipPermissions');
    const skipRef = useRef(skipPermissions);
    skipRef.current = skipPermissions;
    const busyRef = useRef(false);
    const [spawning, setSpawning] = useState(false);
    const [spawnError, setSpawnError] = useState<string | null>(null);

    const enable = useCallback(async (machineId: string, opts?: { forceNew?: boolean }) => {
        if (busyRef.current) return null;
        busyRef.current = true;
        setSpawning(true);
        setSpawnError(null);
        try {
            // spec §2.1: the daemon writes the pointer after a spawn. The web writes it only when
            // MOVING (a pointer exists and names another machine — the daemon would refuse the spawn
            // with main_agent_on_other_machine otherwise): machineId + sessionId null.
            if (credentials && shouldWritePointerBeforeSpawn(useMainAgentStore.getState().pointer, machineId)) {
                try { await writeMainAgentPointer(credentials, machineId); } catch { /* legacy fallback */ }
            }
            const res = await machineSpawnNewSession({
                source: 'assistant',
                machineId,
                directory: ASSISTANT_DIRECTORY,
                approvedNewDirectoryCreation: true,
                agent: 'claude',
                variant: 'assistant',
                ...(opts?.forceNew ? { forceNew: true } : {}),
                ...(skipRef.current ? {} : { permissionMode: 'default' }),
            });
            if (res.type !== 'success') {
                const msg = res.type === 'error' ? res.errorMessage : 'spawn-failed';
                setSpawnError(msg.includes(MAIN_AGENT_OTHER_MACHINE_ERROR) ? MAIN_AGENT_OTHER_MACHINE_ERROR : msg);
                return null;
            }
            storage.getState().updateSessionPermissionMode(res.sessionId, skipRef.current ? 'bypassPermissions' : 'default');
            useAssistantStore.getState().setSessionId(res.sessionId);
            // keep the B-051 setting in step so older web builds open the same session
            sync.applySettings({ assistantMachineId: machineId });
            return res.sessionId;
        } finally {
            busyRef.current = false;
            setSpawning(false);
        }
    }, [credentials]);

    const replace = useCallback(async (machineId: string, previousId: string | null) => {
        const fresh = await enable(machineId, { forceNew: true });
        // archive AFTER the new one exists; skip when spawn failed or an old daemon reused the id
        if (previousId && fresh && fresh !== previousId) await sessionArchive(previousId);
        return fresh;
    }, [enable]);

    return { spawning, spawnError, enable, replace };
}
