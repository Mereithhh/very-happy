import type { TeamState } from '@slopus/happy-wire';

export function teamPollOperations(teams: TeamState[], capabilities: {teamLaunchVersion?: number; teamArchiveVersion?: number}) {
    return teams.filter(team => team.archivedAt === undefined || capabilities.teamArchiveVersion === 1)
        .flatMap(team => team.operations)
        .filter(op => !op.teamLaunchVersion || capabilities.teamLaunchVersion === 1)
        .filter(op => ['pending', 'claimed', 'unknown', 'failed'].includes(op.status) && op.error !== 'task_closed_before_spawn');
}
