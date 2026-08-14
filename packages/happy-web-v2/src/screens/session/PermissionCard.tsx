/**
 * PermissionCard — inline card shown when a session has pending permission
 * requests (Session.agentState.requests). Wires approve / approve-for-session /
 * deny to the sync ops layer.
 */
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useSession } from '@/sync/storage';
import { isMirrorSession } from '@/assistant/assistantSession';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import { CodeView } from './CodeView';
import { Markdown } from './Markdown';
import { AskUserQuestionOptions } from './AskUserQuestionView';
import { isMutableTool, knownTools } from '@/components/tools/knownTools';
import './permission.css';

type Pending = { id: string; tool: string; arguments: any; createdAt?: number | null };

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
    const [busy, setBusy] = useState<null | 'approve' | 'session' | 'deny'>(null);
    const detail = describeArgs(req.tool, req.arguments);
    const mutable = isMutableTool(req.tool);

    // ExitPlanMode: show the plan as Markdown, not an arguments JSON blob.
    // AskUserQuestion: show the actual options — picking one approves the
    // request AND sends the label as a plain user message. Both parse through
    // the knownTools zod schema and fall back to the JSON detail on failure.
    const isPlan = req.tool === 'ExitPlanMode' || req.tool === 'exit_plan_mode';
    const planParsed = isPlan ? knownTools['ExitPlanMode'].input.safeParse(req.arguments ?? {}) : null;
    const plan =
        planParsed?.success && typeof planParsed.data.plan === 'string' && planParsed.data.plan.trim() !== ''
            ? planParsed.data.plan
            : null;
    const askParsed =
        req.tool === 'AskUserQuestion' ? knownTools['AskUserQuestion'].input.safeParse(req.arguments ?? {}) : null;
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
                await sessionAllow(sessionId, req.id, undefined, [req.tool], 'approved_for_session');
            } else {
                await sessionAllow(sessionId, req.id, undefined, undefined, 'approved');
            }
        } finally {
            setBusy(null);
        }
    };

    // Answering a question = approve the pending request, then send the picked
    // label(s) as a normal user message (the model consumes exactly that).
    const answer = async (text: string) => {
        setBusy('approve');
        try {
            await sessionAllow(sessionId, req.id, undefined, undefined, 'approved');
            await sync.sendMessage(sessionId, text, { source: 'question' });
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
                <AskUserQuestionOptions questions={questions} disabled={!!busy} onSubmit={(text) => void answer(text)} />
            ) : (
                detail && <CodeView code={detail} lang={req.tool === 'Bash' ? 'bash' : null} />
            )}
            <div className="perm-actions">
                <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={!!busy} onClick={() => act('approve')}>
                    {t('session.permission.approve')}
                </Button>
                {mutable && (
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

export function PermissionCard({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const requestsObj = session?.agentState?.requests ?? null;
    const [busyAll, setBusyAll] = useState<null | 'approve' | 'deny'>(null);

    // B-105: a terminal mirror is strictly read-only — permission UI never
    // renders, whatever agentState claims (approval happens in the TUI).
    if (session && isMirrorSession(session)) return null;
    if (!requestsObj) return null;
    const requests: Pending[] = Object.entries(requestsObj).map(([id, r]) => ({
        id,
        tool: (r as any).tool,
        arguments: (r as any).arguments,
        createdAt: (r as any).createdAt,
    }));
    if (requests.length === 0) return null;

    const batch = async (kind: 'approve' | 'deny') => {
        setBusyAll(kind);
        try {
            for (const r of requests) {
                if (kind === 'approve') {
                    await sessionAllow(sessionId, r.id, undefined, undefined, 'approved');
                } else {
                    await sessionDeny(sessionId, r.id, undefined, undefined, 'denied');
                }
            }
        } finally {
            setBusyAll(null);
        }
    };

    return (
        <div className="perm-card" role="alertdialog" aria-label={t('session.permission.title')}>
            <div className="perm-card-head">
                <ShieldAlert size={16} />
                <span className="perm-title">{t('session.permission.title')}</span>
                <span className="perm-count">{t('session.permission.pending', { count: requests.length })}</span>
            </div>
            <div className="perm-list">
                {requests.map((r) => (
                    <PermissionRequestRow key={r.id} sessionId={sessionId} req={r} />
                ))}
            </div>
            {requests.length > 1 && (
                <div className="perm-batch">
                    <Button size="sm" variant="primary" loading={busyAll === 'approve'} disabled={!!busyAll} onClick={() => batch('approve')}>
                        {t('session.permission.approveAll')}
                    </Button>
                    <Button size="sm" variant="ghost" loading={busyAll === 'deny'} disabled={!!busyAll} onClick={() => batch('deny')}>
                        {t('session.permission.denyAll')}
                    </Button>
                </div>
            )}
        </div>
    );
}
