/**
 * PermissionCard — the pending-request dock shown when a session has pending
 * permission requests (Session.agentState.requests). Wires approve /
 * approve-for-session / deny to the sync ops layer.
 *
 * B-563: it lives ABOVE THE COMPOSER (SessionDetailScreen's foot), not at the
 * end of the scrolling transcript — a user reading back must still see that
 * the agent is blocked on them. It folds to one summary line; a request the
 * user has not seen re-opens it (permissionDock.ts). The transcript keeps only
 * a one-line PermissionPointer, never a second actionable copy.
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useSession } from '@/sync/storage';
import { isMirrorSession } from '@/assistant/assistantSession';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import { CodeView } from './CodeView';
import { Markdown } from './Markdown';
import { AskUserQuestionOptions } from './AskUserQuestionView';
import { ElicitationRequestView } from './ElicitationRequestView';
import { isMutableTool, knownTools } from '@/components/tools/knownTools';
import { sessionApprovalPolicy } from './permissionCompatibility';
import { planApprovalMode } from './planApprovalMode';
import {
    collapsePermissionDock,
    expandPermissionDock,
    isDockCollapsed,
    permissionDockDomId,
    requestSummary,
    usePermissionDockFolded,
} from './permissionDock';
import './permission.css';

type Pending = {
    id: string;
    tool: string;
    arguments: any;
    createdAt?: number | null;
    kind?: 'tool' | 'elicitation' | 'user_dialog';
    permissionSuggestions?: unknown[];
};

function describeArgs(tool: string, args: any): string | null {
    if (!args || typeof args !== 'object') return null;
    if (tool === 'Bash' && typeof args.command === 'string') return args.command;
    if (typeof args.file_path === 'string') return args.file_path;
    try {
        return JSON.stringify(args, null, 2);
    } catch {
        return null;
    }
}

function PermissionRequestRow({ sessionId, req }: { sessionId: string; req: Pending }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const [busy, setBusy] = useState<null | 'approve' | 'session' | 'deny'>(null);
    const detail = describeArgs(req.tool, req.arguments);
    const isElicitation = req.kind === 'elicitation';
    const isUserDialog = req.kind === 'user_dialog';
    const sessionApproval = sessionApprovalPolicy(req, isMutableTool(req.tool));

    // ExitPlanMode: show the plan as Markdown, not an arguments JSON blob.
    // AskUserQuestion: show the actual options — picking one approves the
    // request with the SDK's question-text-keyed answers map. Both parse
    // through the knownTools zod schema and fall back to JSON on failure.
    const isPlan = req.tool === 'ExitPlanMode' || req.tool === 'exit_plan_mode';
    const planParsed = isPlan ? knownTools['ExitPlanMode'].input.safeParse(req.arguments ?? {}) : null;
    const plan =
        planParsed?.success && typeof planParsed.data.plan === 'string' && planParsed.data.plan.trim() !== ''
            ? planParsed.data.plan
            : null;
    const isAskUserQuestion = req.tool === 'AskUserQuestion' && !isElicitation && !isUserDialog;
    const askParsed = isAskUserQuestion
        ? knownTools['AskUserQuestion'].input.safeParse(req.arguments ?? {})
        : null;
    const questions =
        askParsed?.success && Array.isArray(askParsed.data.questions) && askParsed.data.questions.length > 0
            ? askParsed.data.questions
            : null;

    const act = async (kind: 'approve' | 'session' | 'deny') => {
        setBusy(kind);
        try {
            if (kind === 'deny') {
                await sessionDeny(sessionId, req.id, undefined, undefined, 'denied');
            } else if (kind === 'session') {
                await sessionAllow(sessionId, req.id, planApprovalMode(req.tool, session?.permissionMode), sessionApproval.allowedTools, 'approved_for_session');
            } else {
                await sessionAllow(sessionId, req.id, planApprovalMode(req.tool, session?.permissionMode), undefined, 'approved');
            }
        } finally {
            setBusy(null);
        }
    };

    // AskUserQuestion is itself the blocking interaction. Supplying answers in
    // updatedInput lets the SDK produce the tool result before Claude resumes.
    const answer = async (answers: Record<string, string>) => {
        setBusy('approve');
        try {
            await sessionAllow(sessionId, req.id, undefined, undefined, 'approved', { answers });
        } finally {
            setBusy(null);
        }
    };

    const answerElicitation = async (content: Record<string, string | number | boolean | string[]>) => {
        setBusy('approve');
        try {
            await sessionAllow(sessionId, req.id, undefined, undefined, 'approved', content);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="perm-req">
            <div className="perm-req-head">
                <span className="perm-tool">{req.tool}</span>
                <span className="perm-sub">{t('session.permission.requests', { tool: req.tool })}</span>
            </div>
            {plan ? (
                <div className="perm-plan">
                    <Markdown text={plan} />
                </div>
            ) : questions ? (
                <AskUserQuestionOptions questions={questions} disabled={!!busy} onSubmit={(answers) => void answer(answers)} />
            ) : isElicitation ? (
                <ElicitationRequestView request={req.arguments ?? {}} disabled={!!busy} submitLabel={t('session.permission.approve')} onSubmit={(content) => void answerElicitation(content)} />
            ) : (
                detail && <CodeView code={detail} lang={req.tool === 'Bash' ? 'bash' : null} />
            )}
            <div className="perm-actions">
                {!isAskUserQuestion && !isElicitation && (
                    <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={!!busy} onClick={() => act('approve')}>
                        {t('session.permission.approve')}
                    </Button>
                )}
                {!isAskUserQuestion && !isElicitation && !isUserDialog && sessionApproval.visible && (
                    <Button size="sm" variant="secondary" loading={busy === 'session'} disabled={!!busy} onClick={() => act('session')}>
                        {t('session.permission.approveForSession')}
                    </Button>
                )}
                <Button size="sm" variant="danger" loading={busy === 'deny'} disabled={!!busy} onClick={() => act('deny')}>
                    {t('session.permission.deny')}
                </Button>
            </div>
        </div>
    );
}

function usePendingRequests(sessionId: string): Pending[] {
    const session = useSession(sessionId);
    const requestsObj = session?.agentState?.requests ?? null;
    // B-105: a terminal mirror is strictly read-only — permission UI never
    // renders, whatever agentState claims (approval happens in the TUI).
    if (!requestsObj || (session && isMirrorSession(session))) return [];
    return Object.entries(requestsObj).map(([id, r]) => ({
        id,
        tool: (r as any).tool,
        arguments: (r as any).arguments,
        createdAt: (r as any).createdAt,
        kind: (r as any).kind,
        permissionSuggestions: (r as any).permissionSuggestions,
    }));
}

export function PermissionCard({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const requests = usePendingRequests(sessionId);
    const folded = usePermissionDockFolded(sessionId);
    const [busyAll, setBusyAll] = useState<null | 'approve' | 'deny'>(null);

    if (requests.length === 0) return null;
    const ids = requests.map((request) => request.id);
    const collapsed = isDockCollapsed(folded, ids);
    const hasInteractiveQuestion = requests.some((request) => request.tool === 'AskUserQuestion' || request.kind === 'elicitation' || request.kind === 'user_dialog');

    const batch = async (kind: 'approve' | 'deny') => {
        setBusyAll(kind);
        try {
            for (const r of requests) {
                if (kind === 'approve') {
                    await sessionAllow(sessionId, r.id, planApprovalMode(r.tool, session?.permissionMode), undefined, 'approved');
                } else {
                    await sessionDeny(sessionId, r.id, undefined, undefined, 'denied');
                }
            }
        } finally {
            setBusyAll(null);
        }
    };

    const bodyId = `${permissionDockDomId(sessionId)}-body`;
    return (
        <div className="perm-dock" id={permissionDockDomId(sessionId)}>
            <div className={`perm-card${collapsed ? ' perm-card--collapsed' : ''}`} role="alertdialog" aria-label={t('session.permission.title')}>
                <button
                    type="button"
                    className="perm-card-head"
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                    title={collapsed ? t('session.permission.expand') : t('session.permission.collapse')}
                    onClick={() => (collapsed ? expandPermissionDock(sessionId) : collapsePermissionDock(sessionId, ids))}
                >
                    <ShieldAlert size={16} aria-hidden />
                    <span className="perm-title">{t('session.permission.title')}</span>
                    {collapsed && <span className="perm-summary">{requestSummary(requests[0])}</span>}
                    <span className="perm-count">{t('session.permission.pending', { count: requests.length })}</span>
                    {collapsed ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
                </button>
                <div className="perm-dock-body" id={bodyId} hidden={collapsed}>
                    <div className="perm-list">
                        {requests.map((r) => (
                            <PermissionRequestRow key={r.id} sessionId={sessionId} req={r} />
                        ))}
                    </div>
                    {requests.length > 1 && (
                        <div className="perm-batch">
                            {!hasInteractiveQuestion && (
                                <Button size="sm" variant="primary" loading={busyAll === 'approve'} disabled={!!busyAll} onClick={() => batch('approve')}>
                                    {t('session.permission.approveAll')}
                                </Button>
                            )}
                            <Button size="sm" variant="ghost" loading={busyAll === 'deny'} disabled={!!busyAll} onClick={() => batch('deny')}>
                                {t('session.permission.denyAll')}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** B-563: the transcript's one-line pointer to the dock (not actionable itself). */
export function PermissionPointer({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const requests = usePendingRequests(sessionId);
    if (requests.length === 0) return null;
    const show = () => {
        expandPermissionDock(sessionId);
        requestAnimationFrame(() => {
            const head = document.getElementById(permissionDockDomId(sessionId))?.querySelector<HTMLElement>('.perm-card-head');
            head?.focus();
        });
    };
    return (
        <div className="perm-pointer">
            <ShieldAlert size={14} aria-hidden />
            <span className="perm-pointer-text">{t('session.permission.pointer', { count: requests.length })}</span>
            <button type="button" className="perm-pointer-action" onClick={show}>
                {t('session.permission.pointerAction')}
            </button>
        </div>
    );
}
