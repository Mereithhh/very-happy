/**
 * B-873: an in-memory stand-in for the S line's `/v1/issues*` routes (spec
 * 2026-11-issues §3/§6/§9), used by the Web mechanism tests, the DEV device
 * harness (`/dev/device/issues#issues`) and the e2e flow until B-872 is
 * deployed. It validates with the wire request schemas and decides runs with
 * the same wire pure functions the server uses (`issueShouldRun`,
 * `routeIssueComment`, `chooseIssueDelivery`, `checkAgentStatusChange`,
 * `issueStatusOnRunStart`, `issueStatusAfterRunFailure`), so the UI is built
 * against the contract, not against a guess. Not a server: no auth, no
 * dispatch queue, no attention bridge — `agent.*` drives what a daemon and an
 * agent would do.
 */
import {
    agentAssigneeOf,
    checkAgentStatusChange,
    chooseIssueDelivery,
    formatIssueKey,
    IssueCommentCreateSchema,
    IssueCreateSchema,
    IssueRunCreateSchema,
    IssueUpdateSchema,
    issueShouldRun,
    issueStatusAfterRunFailure,
    issueStatusOnRunStart,
    isIssueRunActive,
    ISSUES_DISABLED_ERROR,
    parseIssueRef,
    routeIssueComment,
    type IssueAssigneeView,
    type IssueCommentView,
    type IssueRunView,
    type IssueView,
} from '@slopus/happy-wire';
import type { IssuesMethod, IssuesTransport } from './apiIssues';

export type FakeIssueUpdate =
    | { t: 'issue'; issue: IssueView }
    | { t: 'issue-comment'; comment: IssueCommentView }
    | { t: 'issue-run'; run: IssueRunView };

export interface FakeIssuesServer {
    transport: IssuesTransport;
    /** `VH_ISSUES_ENABLED` off: every route 404 `issues_disabled`. */
    setEnabled(enabled: boolean): void;
    setWorkers(workers: { machineId: string; workerVersion: number; lastSeenAt: number }[]): void;
    subscribe(listener: (update: FakeIssueUpdate) => void): () => void;
    issues(): IssueView[];
    runs(): IssueRunView[];
    comments(issueId: string): IssueCommentView[];
    /** What a daemon + agent do for a run. */
    agent: {
        start(runId: string, sessionId: string): void;
        comment(runId: string, body: string, mentionOwner?: boolean): void;
        setStatus(runId: string, status: string, comment?: string): { ok: boolean; code?: string };
        idle(runId: string): void;
        fail(runId: string, error: string): void;
    };
}

type Json = Record<string, unknown>;

/** `latestRuns: false` = a server before B-872 e1fabb3a (the list carries no runs). */
export function createFakeIssuesServer(opts: { now?: () => number; enabled?: boolean; latestRuns?: boolean } = {}): FakeIssuesServer {
    const now = opts.now ?? (() => Date.now());
    let enabled = opts.enabled ?? true;
    let workers: { machineId: string; workerVersion: number; lastSeenAt: number }[] = [];
    let seq = 0;
    let ids = 0;
    const issues = new Map<string, IssueView>();
    const comments = new Map<string, IssueCommentView[]>();
    const runs = new Map<string, IssueRunView>();
    const listeners = new Set<(u: FakeIssueUpdate) => void>();
    const emit = (u: FakeIssueUpdate) => { for (const l of listeners) l(structuredClone(u)); };
    const nextId = (prefix: string) => `${prefix}_${(++ids).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const save = (issue: IssueView, changed: Partial<IssueView>): IssueView => {
        const next = { ...issue, ...changed, version: issue.version + 1, updatedAt: now() };
        issues.set(next.id, next);
        emit({ t: 'issue', issue: next });
        return next;
    };
    const addComment = (issueId: string, c: Partial<IssueCommentView> & Pick<IssueCommentView, 'kind' | 'author' | 'body'>): IssueCommentView => {
        const comment: IssueCommentView = { id: nextId('c'), issueId, data: null, mentions: [], refSessionId: null, routedRunIds: [], ownerAckedAt: null, createdAt: now(), editedAt: null, deletedAt: null, ...c };
        comments.set(issueId, [...(comments.get(issueId) ?? []), comment]);
        emit({ t: 'issue-comment', comment });
        return comment;
    };
    const saveRun = (run: IssueRunView): IssueRunView => { runs.set(run.id, run); emit({ t: 'issue-run', run }); return run; };
    const issueRuns = (issueId: string) => [...runs.values()].filter((r) => r.issueId === issueId);
    const system = (issueId: string, kind: string, body: string, data: Json | null = null) => addComment(issueId, { kind, author: { kind: 'system' }, body, data });

    function startRun(issue: IssueView, trigger: string, target: { agent: string; machineId: string }, triggerCommentId: string | null = null): IssueRunView {
        for (const old of issueRuns(issue.id)) if (isIssueRunActive(old.status) && (trigger === 'assign' || trigger === 'retry')) saveRun({ ...old, status: 'superseded', endedAt: now() });
        const assigned = issue.assignee.kind === 'agent' ? issue.assignee as Extract<IssueAssigneeView, { kind: 'agent' }> : null;
        const sameAgent = assigned && assigned.agent === target.agent && assigned.machineId === target.machineId;
        const run = saveRun({
            id: nextId('run'), issueId: issue.id, seq: issueRuns(issue.id).length + 1, trigger, triggerCommentId, status: 'queued',
            agent: target.agent, machineId: target.machineId, agentProfile: sameAgent ? assigned!.agentProfile : undefined,
            model: sameAgent ? assigned!.model ?? null : null, permissionMode: sameAgent ? assigned!.permissionMode ?? null : null,
            directory: (sameAgent ? assigned!.directory : undefined) ?? '/repo', sessionId: null, error: null, failureAckedAt: null,
            createdAt: now(), claimedAt: null, startedAt: null, endedAt: null,
        });
        system(issue.id, 'run', `run ${run.seq} queued`, { runId: run.id, trigger });
        save(issues.get(issue.id)!, { latestRunId: run.id });
        return run;
    }

    const fail = (status: number, error: string, details: Json = {}) => ({ status, data: { error, ...details } });
    const ok = (data: unknown) => ({ status: 200, data });
    const find = (idOrKey: string): IssueView | undefined => {
        const direct = issues.get(idOrKey);
        if (direct) return direct;
        const ref = parseIssueRef(idOrKey);
        return ref && 'number' in ref ? [...issues.values()].find((i) => i.number === ref.number) : undefined;
    };
    const detail = (issue: IssueView) => ({
        issue,
        comments: (comments.get(issue.id) ?? []).filter((c) => !c.deletedAt),
        runs: issueRuns(issue.id).sort((a, b) => a.seq - b.seq),
        children: [...issues.values()].filter((i) => i.parentId === issue.id && !i.deletedAt).map((i) => ({ id: i.id, key: i.key, title: i.title, status: i.status })),
    });

    const routes = (method: IssuesMethod, path: string, body: unknown): { status: number; data: unknown } => {
        const [rawPath, rawQuery = ''] = path.split('?');
        const parts = rawPath.split('/').filter(Boolean).map(decodeURIComponent);
        const query = new URLSearchParams(rawQuery);
        if (method === 'GET' && parts.length === 0) {
            const since = query.get('updatedSince');
            let list = [...issues.values()];
            if (since) list = list.filter((i) => i.updatedAt > Number(since));
            else if (query.get('includeDeleted') !== '1') list = list.filter((i) => !i.deletedAt);
            const q = query.get('q')?.toLowerCase();
            if (q) list = list.filter((i) => i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
            const limit = Number(query.get('limit') ?? 500);
            const page = list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
            const latestRuns = page.flatMap((i) => (i.latestRunId && runs.get(i.latestRunId) ? [runs.get(i.latestRunId)!] : []));
            return ok({ issues: page, nextCursor: null, asOf: now(), ...(opts.latestRuns === false ? {} : { latestRuns }) });
        }
        if (method === 'GET' && parts[0] === 'session' && parts.length === 2) {
            const run = [...runs.values()].find((r) => r.sessionId === parts[1]);
            const issue = run ? issues.get(run.issueId) : undefined;
            if (!run || !issue || issue.deletedAt) return ok({ issue: null, run: null, current: false, comments: [], asOf: now() });
            return ok({ issue, run, current: isIssueRunActive(run.status), comments: [], asOf: now() });
        }
        if (method === 'GET' && parts[0] === 'workers') return ok({ workers });
        if (method === 'POST' && parts[0] === 'import-legacy-todos') return ok({ imported: 0, updated: 0, skipped: 0, conflicts: 0, invalid: 0 });
        if (method === 'POST' && parts[0] === 'runs' && parts.length === 3) {
            const run = runs.get(parts[1]);
            if (!run) return fail(404, 'issue_run_not_found');
            if (parts[2] === 'cancel') return ok({ run: saveRun({ ...run, status: 'cancelled', endedAt: now() }) });
            if (parts[2] === 'ack-failure') return ok({ run: saveRun({ ...run, failureAckedAt: now() }) });
        }
        if (method === 'POST' && parts.length === 0) {
            const parsed = IssueCreateSchema.safeParse(body);
            if (!parsed.success) return fail(400, 'invalid_request');
            const input = parsed.data;
            if (input.assignee?.kind === 'team') return fail(400, 'issue_assignee_unsupported');
            const assignee = (input.assignee ?? { kind: 'none' }) as IssueAssigneeView;
            const number = issues.size + 1;
            const t = now();
            const issue: IssueView = {
                id: nextId('iss'), number, key: formatIssueKey(number), title: input.title, description: input.description ?? '',
                status: input.status ?? (assignee.kind === 'agent' ? 'todo' : 'backlog'), priority: input.priority ?? 'none', assignee,
                projectId: input.projectId ?? null, labels: input.labels ?? [], dueAt: input.dueAt ?? null, parentId: input.parentId ?? null,
                sortOrder: -(++seq), createdBy: { kind: 'user' }, statusRunId: null, latestRunId: null, legacyTodoId: null,
                createdAt: t, updatedAt: t, statusChangedAt: t, startedAt: null, completedAt: null, deletedAt: null, version: 1,
            };
            issues.set(issue.id, issue);
            emit({ t: 'issue', issue });
            const target = agentAssigneeOf(issue.assignee);
            const run = target && issueShouldRun(issue.status, issue.assignee) ? startRun(issue, 'assign', target) : null;
            return ok({ issue: issues.get(issue.id), runs: run ? [run] : [] });
        }
        const issue = parts[0] ? find(parts[0]) : undefined;
        if (!issue) return fail(404, 'issue_not_found');
        if (method === 'GET' && parts.length === 1) return ok(detail(issue));
        if (method === 'DELETE' && parts.length === 1) return ok({ issue: save(issue, { deletedAt: now() }) });
        if (method === 'PATCH' && parts.length === 1) {
            const parsed = IssueUpdateSchema.safeParse(body);
            if (!parsed.success) return fail(400, 'invalid_request');
            const { ifVersion, ...patch } = parsed.data;
            if (ifVersion !== undefined && ifVersion !== issue.version) return fail(409, 'issue_version_conflict', { issue });
            if (patch.assignee?.kind === 'team') return fail(400, 'issue_assignee_unsupported');
            const before = issue;
            const changed: Partial<IssueView> = { ...(patch as Partial<IssueView>) };
            if (patch.status && patch.status !== before.status) {
                changed.statusChangedAt = now();
                changed.statusRunId = null;
                if (patch.status === 'done' || patch.status === 'cancelled') changed.completedAt = now();
            }
            let next = save(before, changed);
            if (patch.status && patch.status !== before.status) system(next.id, 'status', `${before.status} → ${patch.status}`, { from: before.status, to: patch.status });
            const prevAgent = agentAssigneeOf(before.assignee);
            const nextAgent = agentAssigneeOf(next.assignee);
            const assigneeChanged = patch.assignee && JSON.stringify(patch.assignee) !== JSON.stringify(before.assignee);
            if (assigneeChanged) system(next.id, 'assign', 'assignee changed', { from: before.assignee, to: next.assignee });
            const started: IssueRunView[] = [];
            if (nextAgent && issueShouldRun(next.status, next.assignee)) {
                const switched = assigneeChanged && (!prevAgent || prevAgent.agent !== nextAgent.agent || prevAgent.machineId !== nextAgent.machineId);
                const reopened = patch.status && !issueShouldRun(before.status, before.assignee) && !issueRuns(next.id).some((r) => isIssueRunActive(r.status));
                if (switched || reopened) started.push(startRun(next, 'assign', nextAgent));
            }
            next = issues.get(next.id)!;
            return ok({ issue: next, runs: started });
        }
        if (method === 'POST' && parts[1] === 'comments') {
            const parsed = IssueCommentCreateSchema.safeParse(body);
            if (!parsed.success) return fail(400, 'invalid_request');
            const mentions = parsed.data.mentions ?? [];
            const route = routeIssueComment({ authorKind: 'user', body: parsed.data.body, mentions, status: issue.status, assignee: issue.assignee });
            let comment = addComment(issue.id, { kind: 'comment', author: { kind: 'user' }, body: parsed.data.body, mentions });
            const routed: string[] = [];
            const started: IssueRunView[] = [];
            if (route.kind === 'route') {
                for (const target of route.targets) {
                    const live = (sid: string) => [...runs.values()].some((r) => r.sessionId === sid && (r.status === 'running' || r.status === 'idle'));
                    const delivery = chooseIssueDelivery(target, issueRuns(issue.id), live);
                    if (delivery.mode === 'spawn') {
                        const machineId = target.machineId ?? agentAssigneeOf(issue.assignee)?.machineId;
                        if (!machineId) continue;
                        const run = startRun(issues.get(issue.id)!, target.viaMention ? 'mention' : 'comment', { agent: target.agent, machineId }, comment.id);
                        started.push(run);
                        routed.push(run.id);
                    } else routed.push(delivery.runId);
                }
            }
            // A human comment handles every open owner mention on the issue (spec §6).
            for (const c of comments.get(issue.id) ?? []) if (c.mentions.some((m) => m.kind === 'owner') && !c.ownerAckedAt) {
                const acked = { ...c, ownerAckedAt: now() };
                comments.set(issue.id, (comments.get(issue.id) ?? []).map((x) => (x.id === c.id ? acked : x)));
                emit({ t: 'issue-comment', comment: acked });
            }
            if (routed.length) {
                comment = { ...comment, routedRunIds: routed };
                comments.set(issue.id, (comments.get(issue.id) ?? []).map((x) => (x.id === comment.id ? comment : x)));
                emit({ t: 'issue-comment', comment });
            }
            return ok({ issue: issues.get(issue.id), comment, runs: started });
        }
        if (method === 'POST' && parts[1] === 'runs') {
            const parsed = IssueRunCreateSchema.safeParse(body ?? {});
            if (!parsed.success) return fail(400, 'invalid_request');
            let current = issue;
            if (parsed.data.assignee && parsed.data.reassign) current = save(issue, { assignee: parsed.data.assignee as IssueAssigneeView });
            const target = parsed.data.assignee ? { agent: parsed.data.assignee.agent, machineId: parsed.data.assignee.machineId } : agentAssigneeOf(current.assignee);
            if (!target) return fail(400, 'issue_assignee_unsupported');
            const run = startRun(current, 'retry', target);
            return ok({ issue: issues.get(issue.id), runs: [run] });
        }
        return fail(404, 'route_not_found');
    };

    const transport: IssuesTransport = async (method, path, body) => {
        if (!enabled) return { status: 404, data: { error: ISSUES_DISABLED_ERROR } };
        return structuredClone(routes(method, path, body === undefined ? undefined : structuredClone(body)));
    };

    const runOf = (runId: string) => {
        const run = runs.get(runId);
        if (!run) throw new Error(`fake: no run ${runId}`);
        return run;
    };
    return {
        transport,
        setEnabled: (next) => { enabled = next; },
        setWorkers: (next) => { workers = next; },
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        issues: () => [...issues.values()],
        runs: () => [...runs.values()],
        comments: (issueId) => comments.get(issueId) ?? [],
        agent: {
            start(runId, sessionId) {
                const run = saveRun({ ...runOf(runId), status: 'running', sessionId, claimedAt: now(), startedAt: now() });
                const issue = issues.get(run.issueId)!;
                const status = issueStatusOnRunStart(issue.status);
                if (status !== issue.status) {
                    save(issue, { status, statusRunId: run.id, statusChangedAt: now(), startedAt: issue.startedAt ?? now() });
                    system(issue.id, 'status', `${issue.status} → ${status}`, { from: issue.status, to: status, runId: run.id });
                }
            },
            comment(runId, body, mentionOwner) {
                const run = runOf(runId);
                addComment(run.issueId, { kind: 'comment', author: { kind: 'agent', sessionId: run.sessionId, runId }, body, mentions: mentionOwner ? [{ kind: 'owner' }] : [] });
            },
            setStatus(runId, status, comment) {
                const run = runOf(runId);
                const issue = issues.get(run.issueId)!;
                const check = checkAgentStatusChange(issue.status, status, comment);
                if (!check.ok) return { ok: false, code: check.code };
                if (comment) addComment(issue.id, { kind: 'comment', author: { kind: 'agent', sessionId: run.sessionId, runId }, body: comment });
                if (status !== issue.status) {
                    save(issue, { status, statusRunId: run.id, statusChangedAt: now() });
                    system(issue.id, 'status', `${issue.status} → ${status}`, { from: issue.status, to: status, runId });
                }
                return { ok: true };
            },
            idle(runId) { saveRun({ ...runOf(runId), status: 'idle' }); },
            fail(runId, error) {
                const run = saveRun({ ...runOf(runId), status: 'failed', error, endedAt: now() });
                const issue = issues.get(run.issueId)!;
                const status = issueStatusAfterRunFailure(issue, run.id);
                system(issue.id, 'run', `run ${run.seq} failed`, { runId, error });
                if (status !== issue.status) save(issue, { status, statusRunId: null, statusChangedAt: now() });
            },
        },
    };
}
