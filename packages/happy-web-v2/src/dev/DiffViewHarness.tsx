/**
 * DEV-only harness (B-613): the real DiffView at a wide (≥720px, split
 * available) and a narrow (<720px, unified only) container width, with and
 * without line numbers. Local example data only.
 */
import { DiffView } from '@/screens/session/DiffView';

const OLD = `import { useEffect, useState } from 'react';
import { fetchSessions } from './api';

export function useSessions(machineId: string) {
    const [sessions, setSessions] = useState([]);
    useEffect(() => {
        fetchSessions(machineId).then(setSessions);
    }, [machineId]);
    return sessions;
}

export const PAGE_SIZE = 50;`;

const NEW = `import { useEffect, useRef, useState } from 'react';
import { fetchSessions, type SessionSummary } from './api';

export function useSessions(machineId: string, pageSize = PAGE_SIZE) {
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const cancelled = useRef(false);
    useEffect(() => {
        cancelled.current = false;
        fetchSessions(machineId, { limit: pageSize }).then((rows) => { if (!cancelled.current) setSessions(rows); });
        return () => { cancelled.current = true; };
    }, [machineId, pageSize]);
    return sessions;
}

export const PAGE_SIZE = 50;`;

export function DiffViewHarness() {
    return <main style={{ padding: 16, display: 'grid', gap: 24, background: 'var(--bg-0)', color: 'var(--text)', minHeight: '100dvh' }}>
        <p>差异视图 · 本地示例</p>
        <section data-probe="wide" style={{ width: 'min(900px, 100%)' }}><DiffView oldText={OLD} newText={NEW} lang="typescript" showLineNumbers /></section>
        <section data-probe="wide-noln" style={{ width: 'min(900px, 100%)' }}><DiffView oldText={OLD} newText={NEW} lang="typescript" /></section>
        <section data-probe="narrow" style={{ width: 'min(600px, 100%)' }}><DiffView oldText={OLD} newText={NEW} lang="typescript" showLineNumbers /></section>
        <section data-probe="write" style={{ width: 'min(900px, 100%)' }}><DiffView oldText="" newText={'line one\nline two'} lang="typescript" /></section>
    </main>;
}
