/**
 * DEV-only (B-873): Issues in the device harness without a server — the
 * in-memory fake (`sync/issuesFake.ts`) answers `/v1/issues*` in-page and its
 * updates play the role of the socket. `#issues` seeds a few issues across the
 * statuses; `#issues-empty` starts empty (the e2e flow); `#issues-off` is the
 * switch off (`issues_disabled`), for the flag-off regression captures. The
 * fake is on `window.__vhIssues` so the e2e can act as the daemon / agent.
 */
import { setIssuesTransport } from '@/sync/apiIssues';
import { createFakeIssuesServer, type FakeIssuesServer } from '@/sync/issuesFake';
import { _forTests, applyIssueCommentUpdate, applyIssueRunUpdate, applyIssueUpdate } from '@/sync/issuesStore';

export function installIssuesHarness(hash: string, machineId: string): () => void {
    const mode = hash === '#issues-off' ? 'off' : hash === '#issues-empty' ? 'empty' : hash === '#issues' ? 'seeded' : null;
    if (!mode) return () => {};
    const server = createFakeIssuesServer({ enabled: mode !== 'off' });
    _forTests.reset();
    setIssuesTransport(server.transport);
    const off = server.subscribe((u) => {
        if (u.t === 'issue') applyIssueUpdate(u.issue);
        else if (u.t === 'issue-comment') applyIssueCommentUpdate(u.comment);
        else applyIssueRunUpdate(u.run);
    });
    const beat = () => server.setWorkers([{ machineId, workerVersion: 1, lastSeenAt: Date.now() }]);
    beat();
    const timer = setInterval(beat, 30_000);
    if (mode === 'seeded') void seed(server, machineId);
    (window as unknown as { __vhIssues?: FakeIssuesServer }).__vhIssues = server;
    return () => { off(); clearInterval(timer); setIssuesTransport(null); _forTests.reset(); };
}

async function seed(server: FakeIssuesServer, machineId: string): Promise<void> {
    const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh');
    const post = (body: unknown) => server.transport('POST', '', body).then((r) => (r.data as { issue: { id: string }; runs?: { id: string }[] }));
    const agent = { kind: 'agent', machineId, agent: 'codex' } as const;
    await post({ title: zh ? '整理发布说明的模板' : 'Tidy up the release-notes template', priority: 'low', labels: ['docs'] });
    await post({ title: zh ? '登录页在 iPad 横屏下按钮被遮住' : 'Login button hidden on iPad landscape', priority: 'high', labels: ['bug', 'web'], status: 'todo', assignee: { kind: 'self' } });
    const running = await post({ title: zh ? '迁移退款链路到新账本' : 'Move refunds to the new ledger', priority: 'urgent', labels: ['payments'], assignee: agent, description: zh ? '三条退款链路逐一迁移，核对上月流水。' : 'Migrate the three refund paths and reconcile last month.' });
    server.agent.start(running.runs![0].id, 'dev-plain');
    const review = await post({ title: zh ? '给导出接口加分页' : 'Paginate the export API', priority: 'medium', labels: ['api'], assignee: agent });
    server.agent.start(review.runs![0].id, 'dev-plain');
    server.agent.setStatus(review.runs![0].id, 'in_progress');
    server.agent.setStatus(review.runs![0].id, 'in_review', zh ? '已加 cursor 分页，单测与回放通过。' : 'Added cursor pagination; unit tests and replay pass.');
    const idle = await post({ title: zh ? '清理过期的特性开关' : 'Remove stale feature flags', priority: 'none', assignee: { ...agent, agent: 'claude' } });
    server.agent.start(idle.runs![0].id, 'dev-board');
    server.agent.idle(idle.runs![0].id);
    const failed = await post({ title: zh ? '升级 Prisma 到 6' : 'Upgrade Prisma to 6', priority: 'medium', assignee: agent });
    server.agent.fail(failed.runs![0].id, zh ? '账号不可用：Codex 账号已过期' : 'agent-profile-unavailable:expired');
    const done = await post({ title: zh ? '修复看板拖拽闪烁' : 'Fix board drag flicker', priority: 'low', status: 'todo' });
    await server.transport('PATCH', `/${done.issue.id}`, { status: 'done' });
}
