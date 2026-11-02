/**
 * B-873 (spec §8 兼容): `/todos` on a server with Issues lands on the
 * unassigned-issues view (`/issues?assignee=none`); with the switch off, an
 * older server, or no answer, it is the old Todos page, unchanged. The page
 * waits for the (usually already settled) `/v1/issues` probe so it never
 * flashes the old page before redirecting.
 */
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { probeIssues, useIssuesAvailability } from '@/sync/issuesStore';
import { RouteLoading } from '@/app/RouteLoading';
import { TodosScreen } from '@/screens/todos/TodosScreen';
import { useTranslation } from '@/i18n/useTranslation';
import { useIssuesBase } from './IssueParts';

export const TODOS_REDIRECT = '/issues?assignee=none';

export function TodosGate() {
    const { t } = useTranslation();
    const availability = useIssuesAvailability();
    const base = useIssuesBase();
    const [settled, setSettled] = useState(availability !== 'unknown');
    useEffect(() => {
        let alive = true;
        void probeIssues().then(() => { if (alive) setSettled(true); });
        return () => { alive = false; };
    }, []);
    if (availability === 'enabled') return <Navigate to={`${base}${TODOS_REDIRECT}`} replace />;
    if (availability === 'disabled' || settled) return <TodosScreen />;
    return <RouteLoading fullViewport={false} label={t('common.loadingWorkspace')} />;
}
