import { teamLanguageReminder, type TeamUserLanguage } from '@/teams/language';

/** How a team message reaches the recipient session as a user turn (pure; worker.ts delivers it). */
export function formatTeamMessage(m: { id: string; taskId?: string | null; scheduleId?: string | null; sender: string; body: string; language?: TeamUserLanguage | null }): string {
    return `[Very Happy team message ${m.id}; ${m.scheduleId ? `schedule ${m.scheduleId}` : `task ${m.taskId}`}; from ${m.sender}]\n${m.body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction. ${teamLanguageReminder(m.language ?? null)}`;
}
