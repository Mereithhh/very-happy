import { TEAM_SKILL } from '@/teams/resources';

/** Managed Teams entry only; ordinary sessions never call this builder. */
export function teamInitialPrompt(goal: string, root: boolean, directory?: string): string {
    const role = root
        ? 'You are the team lead. Inspect your assigned goal, arrange independent work when useful, review member results, integrate changes, and submit the final result for the user to accept. Delegate under your assigned goal using parentTaskId. You must not accept your own root goal.'
        : 'You are a team member. Inspect your assigned task and work in your assigned worktree. Delegate within your task when useful, then submit evidence for the lead to review.';
    return `${TEAM_SKILL}\n\n## Your role\n${role}\n\n## Working directory\n${directory ? JSON.stringify(directory) : "Use your current managed session working directory."}\nDelegate from this working directory unless a different repository was explicitly requested.\n\n## Assigned goal\n${goal}`;
}
