/**
 * B-878 PR-B project sharing — client state: projects shared WITH me (and my
 * pending invitations), the grants of a project I own, and the socket events
 * (`project-share-changed`, `project-share-revoked`) that keep both live.
 * The sessions themselves arrive through the normal session list
 * (`?projectShares=1`), each carrying `share.via === 'project'`.
 */
import { create } from 'zustand';
import { useEffect } from 'react';
import { apiSocket } from './apiSocket';
import { sync } from './sync';
import type { ShareTarget } from './apiSessionShares';
import { createProjectGrant, listIncomingProjectShares, listProjectGrants, respondToProjectGrant, revokeProjectGrant, updateProjectGrant } from './apiProjectShares';
import { ProjectShareChangedSchema, ProjectShareRevokedSchema, type IncomingProjectShare, type ProjectGrantView, type ProjectShareExpiry, type ProjectShareRole } from './projectShareTypes';

export interface ProjectSharesState {
    incoming: IncomingProjectShare[];
    incomingLoaded: boolean;
    /** Grants that ended while open here (the shared project page shows why). */
    ended: Record<string, string>;
    grantsByProject: Record<string, ProjectGrantView[]>;
    refreshIncoming: () => Promise<void>;
    refreshGrants: (projectId: string) => Promise<void>;
    share: (projectId: string, who: ShareTarget, role: ProjectShareRole, expiresInDays: ProjectShareExpiry) => Promise<void>;
    update: (grant: ProjectGrantView, change: { role?: ProjectShareRole; expiresInDays?: ProjectShareExpiry }) => Promise<void>;
    revoke: (grant: ProjectGrantView) => Promise<void>;
    respond: (grantId: string, accept: boolean) => Promise<void>;
}

export const useProjectShares = create<ProjectSharesState>((set, get) => ({
    incoming: [],
    incomingLoaded: false,
    ended: {},
    grantsByProject: {},
    refreshIncoming: async () => {
        const incoming = await listIncomingProjectShares();
        set({ incoming, incomingLoaded: true });
    },
    refreshGrants: async (projectId) => {
        const grants = await listProjectGrants(projectId);
        set((s) => ({ grantsByProject: { ...s.grantsByProject, [projectId]: grants } }));
    },
    share: async (projectId, who, role, expiresInDays) => {
        await createProjectGrant(projectId, who, role, expiresInDays);
        await get().refreshGrants(projectId);
    },
    update: async (grant, change) => {
        await updateProjectGrant(grant.projectId, grant.grantee.id, change);
        await get().refreshGrants(grant.projectId);
    },
    revoke: async (grant) => {
        await revokeProjectGrant(grant.projectId, grant.grantee.id);
        set((s) => ({ grantsByProject: { ...s.grantsByProject, [grant.projectId]: (s.grantsByProject[grant.projectId] ?? []).filter((g) => g.id !== grant.id) } }));
    },
    respond: async (grantId, accept) => {
        await respondToProjectGrant(grantId, accept);
        if (!accept) set((s) => ({ incoming: s.incoming.filter((g) => g.id !== grantId) }));
        await get().refreshIncoming();
        // Accepting / leaving changes which sessions the list carries.
        await sync.refreshSessions();
    },
}));

const changeListeners = new Set<(grantId: string) => void>();
let installed = false;

export function installProjectShareTransport(): void {
    if (installed) return;
    installed = true;
    apiSocket.onMessage('project-share-changed', (data) => {
        const p = ProjectShareChangedSchema.safeParse(data);
        if (!p.success) return;
        const st = useProjectShares.getState();
        void st.refreshIncoming().catch(() => undefined);
        for (const projectId of Object.keys(st.grantsByProject)) void st.refreshGrants(projectId).catch(() => undefined);
        // A session joined or left a project shared with me: re-read the list.
        void sync.refreshSessions().catch(() => undefined);
        for (const fn of changeListeners) fn(p.data.grantId);
    });
    apiSocket.onMessage('project-share-revoked', (data) => {
        const p = ProjectShareRevokedSchema.safeParse(data);
        if (!p.success) return;
        useProjectShares.setState((s) => ({ ended: { ...s.ended, [p.data.grantId]: p.data.reason ?? 'revoked' }, incoming: s.incoming.filter((g) => g.id !== p.data.grantId) }));
        void sync.refreshSessions().catch(() => undefined);
        for (const fn of changeListeners) fn(p.data.grantId);
    });
}

/** The shared project page re-reads itself when its grant changes. */
export function onProjectShareChanged(fn: (grantId: string) => void): () => void {
    installProjectShareTransport();
    changeListeners.add(fn);
    return () => { changeListeners.delete(fn); };
}

export function useIncomingProjectShares(): IncomingProjectShare[] {
    const incoming = useProjectShares((s) => s.incoming);
    const loaded = useProjectShares((s) => s.incomingLoaded);
    const refresh = useProjectShares((s) => s.refreshIncoming);
    useEffect(() => {
        installProjectShareTransport();
        if (!loaded) refresh().catch(() => { /* an old server 404s: nothing to show */ });
    }, [loaded, refresh]);
    return incoming;
}
