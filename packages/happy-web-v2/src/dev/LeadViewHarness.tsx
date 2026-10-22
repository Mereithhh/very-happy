/**
 * DEV-only harness for B-766 B-1 (「只看我和负责人」): the REAL session page of
 * a team lead, fed `leadSessionFixture` (structure of a real long lead
 * session, neutral text). Route `/dev/lead-view/session/dev-lead`, stripped
 * from prod builds. `window.__leadFlood(n)` appends n member submissions with
 * the lead's replies — the inflow the reader must not be scrolled by.
 * Everything is local; nothing is sent.
 */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { SessionDetailScreen } from '@/screens/session/SessionDetailScreen';
import { buildLeadFixture, LEAD_SESSION_ID } from './leadSessionFixture';
import '@/screens/session/session.css';

const NOW = Date.now();

export function LeadViewHarness() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const fixture = buildLeadFixture({ now: NOW });
        storage.getState().applyMachines([{ id: 'dev-machine', seq: 1, createdAt: NOW, updatedAt: NOW, active: true, activeAt: NOW, metadata: { host: 'devbox', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine]);
        storage.getState().applySessions([{
            id: LEAD_SESSION_ID, seq: 1, createdAt: NOW, updatedAt: NOW, active: true, activeAt: NOW,
            metadata: { machineId: 'dev-machine', path: '/repo', host: 'devbox', flavor: 'claude', summary: { text: '登录页改版（示例）', updatedAt: NOW }, capabilities: ['claude-steer-v1'] },
            metadataVersion: 1, agentState: { controlledByUser: false, requests: {} }, agentStateVersion: 1,
            thinking: false, thinkingAt: 0, presence: 'online',
        } as unknown as Session]);
        setTeamNavigationDevOverride([fixture.team]);
        storage.getState().applyMessages(LEAD_SESSION_ID, fixture.normalized);
        storage.getState().applyMessagesLoaded(LEAD_SESSION_ID);
        let extra = 0;
        (window as unknown as { __leadFlood: (n: number) => void }).__leadFlood = (n: number) => {
            extra += n;
            // Same ids for the shared prefix (applyMessages dedups); new ones land at the end, timed now.
            const next = buildLeadFixture({ now: Date.now(), extra });
            setTeamNavigationDevOverride([next.team]);
            storage.getState().applyMessages(LEAD_SESSION_ID, next.normalized.slice(fixture.normalized.length));
        };
        setReady(true);
        return () => setTeamNavigationDevOverride(null);
    }, []);
    return ready ? <SessionDetailScreen /> : null;
}
