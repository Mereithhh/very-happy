/**
 * PermissionCard — inline card shown when a session has pending permission
 * requests (Session.agentState.requests). Wires approve / approve-for-session /
 * deny to the sync ops layer.
 */
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Button } from '@/ui';
import { CodeView } from './CodeView';
import { isMutableTool } from '@/components/tools/knownTools';
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

    return (
        <div className="perm-req">
            <div className="perm-req-head">
                <span className="perm-tool">{req.tool}</span>
                <span className="perm-sub">{t('session.permission.requests' as any, { tool: req.tool })}</span>
            </div>
            {detail && <CodeView code={detail} lang={req.tool === 'Bash' ? 'bash' : null} copyable={false} />}
            <div className="perm-actions">
                <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={!!busy} onClick={() => act('approve')}>
                    {t('session.permission.approve' as any)}
                </Button>
                {mutable && (
                    <Button size="sm" variant="secondary" loading={busy === 'session'} disabled={!!busy} onClick={() => act('session')}>
                        {t('session.permission.approveForSession' as any)}
                    </Button>
                )}
                <Button size="sm" variant="danger" loading={busy === 'deny'} disabled={!!busy} onClick={() => act('deny')}>
                    {t('session.permission.deny' as any)}
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
        <div className="perm-card" role="alertdialog" aria-label={t('session.permission.title' as any)}>
            <div className="perm-card-head">
                <ShieldAlert size={16} />
                <span className="perm-title">{t('session.permission.title' as any)}</span>
                <span className="perm-count">{t('session.permission.pending' as any, { count: requests.length })}</span>
            </div>
            <div className="perm-list">
                {requests.map((r) => (
                    <PermissionRequestRow key={r.id} sessionId={sessionId} req={r} />
                ))}
            </div>
            {requests.length > 1 && (
                <div className="perm-batch">
                    <Button size="sm" variant="primary" loading={busyAll === 'approve'} disabled={!!busyAll} onClick={() => batch('approve')}>
                        {t('session.permission.approveAll' as any)}
                    </Button>
                    <Button size="sm" variant="ghost" loading={busyAll === 'deny'} disabled={!!busyAll} onClick={() => batch('deny')}>
                        {t('session.permission.denyAll' as any)}
                    </Button>
                </div>
            )}
        </div>
    );
}
