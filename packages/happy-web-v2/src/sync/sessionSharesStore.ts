/**
 * B-619 session sharing — client state: invitations waiting for me and the
 * grants of a session I own. Fed by REST plus the three socket updates
 * (`session-share`, `session-share-updated`, `session-share-revoked`) that
 * sync.ts forwards here, so the sidebar and the share dialog never poll.
 *
 * Deliberately outside storage.ts (conflict hot zone), like automationsStore.
 */
import { create } from 'zustand';
import { useEffect } from 'react';
import {
    acceptInvite,
    createSessionGrant,
    declineInvite,
    listPendingInvites,
    listSessionGrants,
    revokeSessionGrant,
    updateSessionGrantRole,
    type ShareTarget,
} from './apiSessionShares';
import type { SessionGrantView, SessionShareRole, SharedSessionInvite } from './sessionShareTypes';

export interface SessionSharesState {
    invites: SharedSessionInvite[];
    invitesLoaded: boolean;
    grantsBySession: Record<string, SessionGrantView[]>;
    refreshInvites: () => Promise<void>;
    refreshGrants: (sessionId: string) => Promise<void>;
    share: (sessionId: string, who: ShareTarget, role: SessionShareRole) => Promise<SessionGrantView>;
    setRole: (sessionId: string, accountId: string, role: SessionShareRole) => Promise<void>;
    revoke: (sessionId: string, accountId: string) => Promise<void>;
    accept: (grantId: string) => Promise<SharedSessionInvite | null>;
    decline: (grantId: string) => Promise<void>;
    /** socket: a new invitation for me */
    onInvite: (invite: SharedSessionInvite) => void;
    /** socket: an invitation of mine was answered / re-roled, or one I received was re-roled */
    onGrantUpdated: (sessionId: string, grantId: string, role: SessionShareRole, status: SessionGrantView['status']) => void;
    /** socket: a share I received is gone */
    onRevoked: (sessionId: string, grantId: string | null) => void;
}

function upsertGrant(list: SessionGrantView[], next: SessionGrantView): SessionGrantView[] {
    const i = list.findIndex((g) => g.id === next.id);
    if (i === -1) return [...list, next];
    const copy = list.slice(); copy[i] = next; return copy;
}

export const useSessionShares = create<SessionSharesState>((set, get) => ({
    invites: [],
    invitesLoaded: false,
    grantsBySession: {},
    refreshInvites: async () => {
        const invites = await listPendingInvites();
        set({ invites, invitesLoaded: true });
    },
    refreshGrants: async (sessionId) => {
        const grants = await listSessionGrants(sessionId);
        set((s) => ({ grantsBySession: { ...s.grantsBySession, [sessionId]: grants } }));
    },
    share: async (sessionId, who, role) => {
        const grant = await createSessionGrant(sessionId, who, role);
        set((s) => ({ grantsBySession: { ...s.grantsBySession, [sessionId]: upsertGrant(s.grantsBySession[sessionId] ?? [], grant) } }));
        return grant;
    },
    setRole: async (sessionId, accountId, role) => {
        const grant = await updateSessionGrantRole(sessionId, accountId, role);
        set((s) => ({ grantsBySession: { ...s.grantsBySession, [sessionId]: upsertGrant(s.grantsBySession[sessionId] ?? [], grant) } }));
    },
    revoke: async (sessionId, accountId) => {
        await revokeSessionGrant(sessionId, accountId);
        set((s) => ({ grantsBySession: { ...s.grantsBySession, [sessionId]: (s.grantsBySession[sessionId] ?? []).filter((g) => g.grantee.id !== accountId) } }));
    },
    accept: async (grantId) => {
        const invite = await acceptInvite(grantId);
        set((s) => ({ invites: s.invites.filter((i) => i.id !== grantId) }));
        return invite;
    },
    decline: async (grantId) => {
        await declineInvite(grantId);
        set((s) => ({ invites: s.invites.filter((i) => i.id !== grantId) }));
    },
    onInvite: (invite) => set((s) => ({ invites: [invite, ...s.invites.filter((i) => i.id !== invite.id)], invitesLoaded: true })),
    onGrantUpdated: (sessionId, grantId, role, status) => {
        const grants = get().grantsBySession[sessionId];
        if (grants?.some((g) => g.id === grantId)) {
            set((s) => ({
                grantsBySession: {
                    ...s.grantsBySession,
                    [sessionId]: status === 'revoked'
                        ? (s.grantsBySession[sessionId] ?? []).filter((g) => g.id !== grantId)
                        : (s.grantsBySession[sessionId] ?? []).map((g) => g.id === grantId ? { ...g, role, status } : g),
                },
            }));
        }
        // A re-role of an invitation I have not answered yet.
        set((s) => ({ invites: s.invites.map((i) => i.id === grantId ? { ...i, role } : i) }));
    },
    onRevoked: (sessionId, grantId) => set((s) => ({ invites: s.invites.filter((i) => i.id !== grantId && i.sessionId !== sessionId) })),
}));

/** Load invitations once per mount of a surface that shows them (sidebar). */
export function useSessionInvites(): SharedSessionInvite[] {
    const invites = useSessionShares((s) => s.invites);
    const loaded = useSessionShares((s) => s.invitesLoaded);
    const refresh = useSessionShares((s) => s.refreshInvites);
    useEffect(() => {
        if (!loaded) refresh().catch(() => { /* surfaced on the next socket update / refetch */ });
    }, [loaded, refresh]);
    return invites;
}
