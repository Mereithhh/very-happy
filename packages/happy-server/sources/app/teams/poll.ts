import type { TeamState } from '@slopus/happy-wire';

export function teamPollOperations(teams: TeamState[], capabilities: {teamLaunchVersion?: number; teamArchiveVersion?: number; teamRestoreVersion?: number}) {
    return teams.filter(team => team.archivedAt === undefined || capabilities.teamArchiveVersion === 1)
        .flatMap(team => team.operations)
        .filter(op => !op.teamLaunchVersion || capabilities.teamLaunchVersion === 1)
        // B-962: a restore launch continues a previous session; an older daemon would start a fresh one instead.
        .filter(op => !op.restoreVersion || capabilities.teamRestoreVersion === 1)
        .filter(op => ['pending', 'claimed', 'unknown', 'failed'].includes(op.status) && op.error !== 'task_closed_before_spawn');
}
