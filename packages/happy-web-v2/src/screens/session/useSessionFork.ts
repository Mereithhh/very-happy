import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitFork } from 'lucide-react';
import { isMirrorSession } from '@/assistant/assistantSession';
import { isSharedWithMe } from '@/app/sessionAccess';
import { useTranslation } from '@/i18n/useTranslation';
import { useMachine, useSession } from '@/sync/storage';
import { toast } from '@/ui/Toast';
import type { MenuItemDef } from '@/ui';
import { ForkFailure, forkWholeSession, sessionRunningNow } from './forkFlow';
import { forkReasonText, isForkableFlavor, sessionForkBlock } from './forkModel';

/**
 * Start a whole-session fork with the B-851/B-860 toasts and navigation, or
 * null where forking is not offered (agents that cannot fork — pi, gemini, …
 * — mirrors, sessions shared with me). A blocked fork (offline machine, no
 * history yet) says why instead of doing nothing. `running` undefined = read
 * the session's liveness at click time. `draft` (B-861 side chat) is what the
 * new composer gets instead of the running turn's prompt.
 */
export function useStartSessionFork(sessionId: string): ((opts?: { running?: boolean; draft?: string }) => void) | null {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const machine = useMachine(session?.metadata?.machineId ?? '');
    const busy = useRef(false);
    if (!session || isSharedWithMe(session) || isMirrorSession(session) || !isForkableFlavor(session.metadata?.flavor)) return null;
    const state = sessionForkBlock(session, { machineOnline: machine?.active === true });
    return ({ running, draft } = {}) => {
        if (typeof state === 'string') { toast.show(forkReasonText(t, state), 'error', { sticky: true }); return; }
        if (busy.current) return;
        busy.current = true;
        toast.show(t('session.forkStarting'), 'info');
        forkWholeSession(session, state.source, running ?? sessionRunningNow(session), draft)
            .then((fork) => {
                navigate(`/session/${encodeURIComponent(fork.id)}`);
                if (fork.partial) {
                    toast.show(t(fork.prefilled ? 'session.forkRunningNoticePrefilled' : 'session.forkRunningNotice'), 'info', { sticky: true });
                }
            })
            .catch((error) => {
                const failure = error instanceof ForkFailure ? error : new ForkFailure('failed', String(error));
                toast.show(forkReasonText(t, failure.kind, failure.message), 'error', { sticky: true });
            })
            .finally(() => { busy.current = false; });
    };
}

/**
 * B-851: the header ⋯ 「分叉会话」 item. B-860: while a turn runs it forks
 * the completed turns, prefills the running message and says so in the new
 * session.
 */
export function useSessionForkItem(sessionId: string, running: boolean): MenuItemDef | null {
    const { t } = useTranslation();
    const start = useStartSessionFork(sessionId);
    if (!start) return null;
    return {
        key: 'fork',
        label: t('session.forkAction'),
        icon: GitFork,
        onSelect: () => start({ running }),
    };
}
