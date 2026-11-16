import type { ProjectLogEntryView } from '@slopus/happy-wire';

/**
 * B-939: who wrote a log entry, as the project page shows it. Sessions read a
 * decision a session wrote as that session's claim, not as the owner's
 * decision in effect — the page says so, so the owner can tell the two apart.
 */
export function logAuthor(
  entry: Pick<ProjectLogEntryView, 'kind' | 'authorSessionId'>,
  sessionName: (id: string) => string,
  copy: { byUser: string; bySession: (name: string) => string; sessionDecision: string },
): { label: string; note: string | null } {
  if (!entry.authorSessionId) return { label: copy.byUser, note: null };
  return { label: copy.bySession(sessionName(entry.authorSessionId)), note: entry.kind === 'decision' ? copy.sessionDecision : null };
}
