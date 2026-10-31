import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitFork } from 'lucide-react';
import { isMirrorSession } from '@/assistant/assistantSession';
import { isSharedWithMe } from '@/app/sessionAccess';
import { useTranslation } from '@/i18n/useTranslation';
import { useMachine, useSession } from '@/sync/storage';
import { toast } from '@/ui/Toast';
import type { MenuItemDef } from '@/ui';
import { ForkFailure, forkWholeSession } from './forkFlow';
import { forkReasonText, isForkableFlavor, sessionForkBlock } from './forkModel';

/**
 * B-851: the header ⋯ 「分叉会话」 item. Hidden for agents that cannot fork
 * (pi, gemini, …), mirrors and sessions shared with me; otherwise always
 * listed, and a blocked fork (offline machine, running turn, no history yet)
 * says why instead of doing nothing.
 */
export function useSessionForkItem(sessionId: string, running: boolean): MenuItemDef | null {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const busy = useRef(false);
    if (!session || isSharedWithMe(session) || isMirrorSession(session) || !isForkableFlavor(session.metadata?.flavor)) return null;
    const state = sessionForkBlock(session, { machineOnline: machine?.active === true, running });
    return {
        key: 'fork',
        label: t('session.forkAction'),
        icon: GitFork,
        onSelect: () => {
            if (typeof state === 'string') { toast.show(forkReasonText(t, state), 'error', { sticky: true }); return; }
            if (busy.current) return;
            busy.current = true;
            toast.show(t('session.forkStarting'), 'info');
            forkWholeSession(session, state.source)
                .then((id) => navigate(`/session/${encodeURIComponent(id)}`))
                .catch((error) => {
                    const failure = error instanceof ForkFailure ? error : new ForkFailure('failed', String(error));
                    toast.show(forkReasonText(t, failure.kind, failure.message), 'error', { sticky: true });
                })
                .finally(() => { busy.current = false; });
        },
    };
}
