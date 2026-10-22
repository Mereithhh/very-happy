import { t, type TranslationKey } from '@/text';
import { teamTaskTone, type TeamTaskState } from './teamTaskState';

const LABEL: Record<TeamTaskState, TranslationKey> = {
    queued: 'teams.taskState.queued', starting: 'teams.taskState.starting', launchFailed: 'teams.taskState.launchFailed',
    working: 'teams.taskState.working', waiting: 'teams.taskState.waiting', idle: 'teams.taskState.idle',
    stopped: 'teams.taskState.stopped', checking: 'teams.taskState.checking', submitted: 'teams.taskState.submitted',
    done: 'teams.taskState.done', cancelled: 'teams.taskState.cancelled',
};

export function teamTaskStateLabel(state: TeamTaskState): string {
    return t(LABEL[state]);
}

/** B-761: the one task status pill — board card, details, list card, chat card. */
export function TeamTaskStatePill({ state, className = '' }: { state: TeamTaskState; className?: string }) {
    const tone = teamTaskTone(state);
    return <span className={`vh-pill teams-task-state${tone ? ` vh-pill--${tone}` : ''}${className ? ` ${className}` : ''}`} data-state={state}>{teamTaskStateLabel(state)}</span>;
}
