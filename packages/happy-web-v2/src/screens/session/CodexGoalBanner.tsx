/**
 * B-953: a Codex session's goal (`/goal <objective>`) — the strip above the
 * composer: the objective, its state and tokens used / budget, with
 * 「暂停」/「继续」/「清除」 sent as the same `/goal` commands a person can type.
 *
 * Codex works an active goal turn after turn by itself, so this stays while a
 * goal exists; a status change (complete, paused, a limit reached, stalled)
 * changes the strip and brings it back after 「隐藏」. Reads only
 * `agentState.codexGoal` (`sessionCodexGoal`, wrappers with codex-goal-v1).
 */
import { useState } from 'react';
import { CircleCheck, Pause, Play, Target, TriangleAlert, X } from 'lucide-react';
import { toast } from '@/ui/Toast';
import { useTranslation } from '@/i18n/useTranslation';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { goalTone, goalUsage, sessionCodexGoal } from '@/sync/codexGoal';
import type { CodexGoalStatus } from '@slopus/happy-wire';
import './mirror.css';

const STATUS_KEY = {
    active: 'session.chat.goalStatus.active',
    paused: 'session.chat.goalStatus.paused',
    blocked: 'session.chat.goalStatus.blocked',
    usageLimited: 'session.chat.goalStatus.usageLimited',
    budgetLimited: 'session.chat.goalStatus.budgetLimited',
    complete: 'session.chat.goalStatus.complete',
} as const satisfies Record<CodexGoalStatus, string>;

export function CodexGoalBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    // Keyed by status + objective: a change shows the strip again.
    const [hidden, setHidden] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const goal = sessionCodexGoal(session);
    if (!goal) return null;
    const key = `${goal.status}:${goal.objective}`;
    if (hidden === key) return null;
    const tone = goalTone(goal.status);
    const usage = goalUsage(goal);
    const send = async (text: string) => {
        if (sending) return;
        setSending(true);
        try {
            await sync.sendMessage(sessionId, text, { source: 'chat' });
        } catch (e) {
            toast.error(t('session.chat.goalSendFailed', { error: e instanceof Error ? e.message : String(e) }));
        } finally {
            setSending(false);
        }
    };
    const Icon = tone === 'done' ? CircleCheck : tone === 'attention' ? TriangleAlert : Target;
    const action = goal.status === 'active'
        ? { text: '/goal pause', label: t('session.chat.goalPause'), Icon: Pause }
        : goal.status === 'complete'
            ? { text: '/goal clear', label: t('session.chat.goalClear'), Icon: X }
            : { text: '/goal resume', label: t('session.chat.goalResume'), Icon: Play };
    return (
        <div className="mrb" data-testid="codex-goal-banner" data-kind="codex-goal" data-tone={tone} data-status={goal.status}>
            <div className="mrb-note" role="status">
                <Icon size={13} />
                <span className="mrb-note-text" title={goal.objective}>
                    <strong>{t(STATUS_KEY[goal.status])}</strong>
                    <span className="mrb-note-sep" aria-hidden> · </span>
                    {/* usage before the objective: on a phone the objective is clamped, the numbers must stay */}
                    {usage && (
                        <>
                            <span className="mrb-goal-usage" data-testid="codex-goal-usage">{t('session.chat.goalTokens', { usage })}</span>
                            <span className="mrb-note-sep" aria-hidden> · </span>
                        </>
                    )}
                    <span className="mrb-goal-objective" data-testid="codex-goal-objective">{goal.objective}</span>
                </span>
                <span className="mrb-note-actions">
                    <button type="button" className="mrb-term-btn" onClick={() => void send(action.text)} disabled={sending}>
                        <action.Icon size={13} />
                        <span>{action.label}</span>
                    </button>
                    <button type="button" className="mrb-dismiss" onClick={() => setHidden(key)}
                        aria-label={t('session.chat.goalHide') as string} title={t('session.chat.goalHide') as string}>
                        <X size={13} />
                    </button>
                </span>
            </div>
        </div>
    );
}
