/**
 * Owner 10-27 「创建出来了，就是不明显」: each entry that starts a session
 * WITHOUT taking the user into it must reach dispatchFeedback (behaviour of the
 * pieces is in dispatchFeedback / teamDispatchWatch / automationRunWatch /
 * sidebarDispatchReveal tests; this pins the wiring). Checked with mutation-check.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('dispatch feedback wiring', () => {
    it('Teams page: 新任务 / 重试 / 转交 hand the before/after team to the watcher', () => {
        expect(src('screens/teams/TeamsScreen.tsx')).toContain('watchTeamDispatch(before, next, p.action);');
    });
    it('立即运行 follows the queued run', () => {
        expect(src('sync/automationsStore.ts')).toContain("import('./automationRunWatch').then((m) => m.watchAutomationRun(run)");
    });
    it('a pending session that lands after the user left its page is announced', () => {
        expect(src('sync/pendingSessionsRuntime.ts')).toContain('if (!isViewingSession(record.pendingId) && !isViewingSession(realId)) announceDispatched(');
    });
    it('a batch import marks its sessions 「新」', () => {
        expect(src('screens/sessions/ImportHistoryModal.tsx')).toContain('if (summary.failed > 0 || !summary.singleSessionId) markFresh(');
    });
    it('AppLayout gives the toast a navigator and clears 「新」 on open', () => {
        const layout = src('screens/AppLayout.tsx');
        expect(layout).toContain('useEffect(() => setDispatchNavigator(navigate), [navigate]);');
        expect(layout).toContain('useEffect(() => { noteDispatchRoute(location.pathname); }, [location.pathname]);');
    });
    it('Sidebar: row 「新」 + flash, folded group / project / area / team hints, one-shot reveal', () => {
        const sidebar = src('screens/sessions/Sidebar.tsx');
        expect(sidebar).toContain('fresh={isFreshRow(r, fresh)}');
        expect(sidebar).toContain('flash={!!r.sessionId && r.sessionId === highlightedSessionId}');
        expect(sidebar).toContain("{fresh && <span className=\"sb-row-new\"");
        expect(sidebar).toContain("}${flash ? ' sb-row--flash' : ''}`}");
        expect(sidebar).toContain('{!sec.open && <FreshHint count={freshRowCount(sec.allRows, fresh)} />}\n                        {!sec.open && <GroupSummary');
        expect(sidebar).toContain('<span className="sb-tree-project-name">{sec.label}</span>\n                              {!sec.open && <FreshHint');
        expect(sidebar).toContain('<span>{sec.label}</span><span className="mono">{sec.count}</span>\n                            {!sec.open && <FreshHint');
        expect(sidebar).toContain('badge={open ? undefined : <FreshHint count={teamFreshCount(team, fresh)} />}');
        expect(sidebar).toContain('consumeDispatchReveal(reveal.seq);');
        expect(sidebar).toContain("if (lr.width === 0 || lr.right <= 0 || lr.left >= window.innerWidth || getComputedStyle(list).visibility === 'hidden') return 'missing';");
        expect(sidebar).toContain('setRevealExpanded((cur) => (cur.has(step.groupId) ? cur : new Set([...cur, step.groupId])));');
    });
});
