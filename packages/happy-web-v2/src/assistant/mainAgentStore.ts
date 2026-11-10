/**
 * mainAgentStore — main agent (B-916a) KV state + drawer UI state.
 *
 * Independent zustand store (assistantStore precedent). Holds:
 *  - the account pointer `vh.main-agent.v1` (daemon writes it on spawn; the
 *    web writes it only when the user enables / moves the main agent);
 *  - the config `vh.main-agent-config.v1` (settings page);
 *  - drawer open + a pending draft (⌘K hands a question over).
 *
 * KV `status: 'unsupported'` = the server has no KV route (404 on the whole
 * API is indistinguishable from "no key", so we only mark unsupported on a
 * thrown non-auth error); the web then falls back to the legacy pick.
 */

import { create } from 'zustand';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { kvGet, kvMutate } from '@/sync/apiKv';
import {
    MAIN_AGENT_CONFIG_KEY,
    MAIN_AGENT_POINTER_KEY,
    EMPTY_MAIN_AGENT_CONFIG,
    decodeKvJson,
    encodeKvJson,
    mergeMainAgentConfig,
    parseMainAgentConfig,
    parseMainAgentPointer,
    nextPointerValue,
    type MainAgentConfig,
    type MainAgentPointer,
} from './mainAgent';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MainAgentStoreState {
    pointerStatus: LoadStatus;
    pointer: MainAgentPointer | null;
    pointerVersion: number;
    configStatus: LoadStatus;
    config: MainAgentConfig;
    configRaw: unknown;
    configVersion: number;
    drawerOpen: boolean;
    /** text to put in (or send from) the composer when the drawer opens */
    pendingDraft: { text: string; send: boolean } | null;

    setDrawerOpen: (open: boolean) => void;
    takePendingDraft: () => { text: string; send: boolean } | null;
    reset: () => void;
}

const initial = {
    pointerStatus: 'idle' as LoadStatus,
    pointer: null,
    pointerVersion: -1,
    configStatus: 'idle' as LoadStatus,
    config: { ...EMPTY_MAIN_AGENT_CONFIG },
    configRaw: null,
    configVersion: -1,
    drawerOpen: false,
    pendingDraft: null,
};

export const useMainAgentStore = create<MainAgentStoreState>((set, get) => ({
    ...initial,
    setDrawerOpen: (open) => set({ drawerOpen: open }),
    takePendingDraft: () => {
        const d = get().pendingDraft;
        if (d) set({ pendingDraft: null });
        return d;
    },
    reset: () => set({ ...initial }),
}));

/** Open the main agent (drawer on desktop, the /main-agent page on phones — the caller routes). */
export function openMainAgent(draft?: { text: string; send: boolean }) {
    useMainAgentStore.setState({ drawerOpen: true, ...(draft ? { pendingDraft: draft } : {}) });
}

export async function refreshMainAgentPointer(creds: AuthCredentials): Promise<void> {
    const st = useMainAgentStore.getState();
    if (st.pointerStatus === 'idle') useMainAgentStore.setState({ pointerStatus: 'loading' });
    try {
        const item = await kvGet(creds, MAIN_AGENT_POINTER_KEY);
        useMainAgentStore.setState({
            pointerStatus: 'ready',
            pointer: item ? parseMainAgentPointer(decodeKvJson(item.value)) : null,
            pointerVersion: item ? item.version : -1,
        });
    } catch {
        // keep the last known pointer; resolution falls back to the legacy pick when none
        useMainAgentStore.setState((s) => ({ pointerStatus: s.pointer ? 'ready' : 'error' }));
    }
}

/**
 * Point the account at a machine (enable / move): `{machineId, sessionId: null}`
 * with generation + 1, written BEFORE the spawn — the daemon refuses to spawn a
 * main agent when the pointer names another machine, and fills `sessionId`
 * itself (spec §2.1). On a version conflict: re-read, write once more, give up.
 */
export async function writeMainAgentPointer(creds: AuthCredentials, machineId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { pointer, pointerVersion } = useMainAgentStore.getState();
        const value = nextPointerValue(pointer, machineId, Date.now());
        const res = await kvMutate(creds, [{ key: MAIN_AGENT_POINTER_KEY, value: encodeKvJson(value), version: pointerVersion }]);
        if (res.success) {
            useMainAgentStore.setState({ pointer: parseMainAgentPointer(value), pointerVersion: res.results[0].version, pointerStatus: 'ready' });
            return true;
        }
        const err = res.errors[0];
        useMainAgentStore.setState({
            pointer: err.value ? parseMainAgentPointer(decodeKvJson(err.value)) : null,
            pointerVersion: err.version,
        });
    }
    return false;
}

export async function loadMainAgentConfig(creds: AuthCredentials): Promise<void> {
    useMainAgentStore.setState({ configStatus: 'loading' });
    try {
        const item = await kvGet(creds, MAIN_AGENT_CONFIG_KEY);
        const raw = item ? decodeKvJson(item.value) : null;
        useMainAgentStore.setState({ configStatus: 'ready', configRaw: raw, config: parseMainAgentConfig(raw), configVersion: item ? item.version : -1 });
    } catch {
        useMainAgentStore.setState({ configStatus: 'error' });
    }
}

/** Save with optimistic concurrency; on a version conflict re-merge onto the newer value once (unknown fields kept). */
export async function saveMainAgentConfig(creds: AuthCredentials, next: MainAgentConfig): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const { configRaw, configVersion } = useMainAgentStore.getState();
        const merged = mergeMainAgentConfig(configRaw, next, Date.now());
        const res = await kvMutate(creds, [{ key: MAIN_AGENT_CONFIG_KEY, value: encodeKvJson(merged), version: configVersion }]);
        if (res.success) {
            useMainAgentStore.setState({ configRaw: merged, config: parseMainAgentConfig(merged), configVersion: res.results[0].version, configStatus: 'ready' });
            return true;
        }
        const err = res.errors[0];
        const raw = err.value ? decodeKvJson(err.value) : null;
        useMainAgentStore.setState({ configRaw: raw, configVersion: err.version });
    }
    return false;
}
