/**
 * UI-P0-01 (B-726): why「开始协作」is disabled, so the form can say it next to
 * the button and send focus to the missing field. `null` = nothing the user
 * can fill in here (machine offline/outdated has its own status line).
 */
export function startBlocker(input: { ready: boolean; goal: string; directory: string }): 'goal' | 'directory' | null {
  if (!input.ready) return null;
  if (!input.goal.trim()) return 'goal';
  if (!input.directory.trim()) return 'directory';
  return null;
}
