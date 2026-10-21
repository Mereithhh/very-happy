import type { TeamTask, TeamState } from "@slopus/happy-wire";
export function taskRows(
  tasks: TeamTask[],
): { task: TeamTask; depth: number }[] {
  const rows: { task: TeamTask; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (task: TeamTask, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    rows.push({ task, depth });
    for (const child of tasks)
      if (child.parentTaskId === task.id) visit(child, depth + 1);
  };
  for (const task of tasks)
    if (!task.parentTaskId || !tasks.some((t) => t.id === task.parentTaskId))
      visit(task, 0);
  // Keep malformed/orphan relationships visible instead of dropping work.
  for (const task of tasks) visit(task, 0);
  return rows;
}

/** Polls and idempotent action replays may finish out of order. */
export function newestTeam(
  current: TeamState | null,
  next: TeamState,
): TeamState {
  return current?.id === next.id && current.version > next.version
    ? current
    : next;
}

export function canReconcileOperation(
  team: TeamState,
  operation: TeamState["operations"][number],
): boolean {
  if (
    !operation.claimId ||
    !["claimed", "unknown", "failed"].includes(operation.status)
  )
    return false;
  const task = team.tasks.find((task) => task.id === operation.taskId);
  return (
    !!task &&
    (["done", "cancelled"].includes(task.status) ||
      task.attempts.some(
        (attempt) =>
          attempt.id === operation.attemptId && attempt.status === "superseded",
      ))
  );
}

/** B-689: the owner may ask the execution computer to rerun a failed or
 *  uncertain launch while its task is still waiting for that attempt. */
export function canRetryLaunch(
  team: TeamState,
  operation: TeamState["operations"][number],
): boolean {
  if (operation.type !== "spawn" || !operation.claimId || !["failed", "unknown"].includes(operation.status)) return false;
  const task = team.tasks.find((task) => task.id === operation.taskId);
  return !!task && task.status === "queued" && task.currentAttemptId === operation.attemptId;
}

/** B-689: machine metadata `teamRetryVersion` — daemons that act on retry-operation. */
export function machineSupportsTeamRetry(metadata: unknown, version = 1): boolean {
  const value = (metadata as { teamRetryVersion?: unknown } | null)?.teamRetryVersion;
  return typeof value === "number" && value >= version;
}

/** B-691: a retained cleanup the owner can ask the computer to re-check now. */
export function canRetryCleanup(operation: TeamState["operations"][number]): boolean {
  return operation.type === "stop" && operation.status === "failed" && !!operation.claimId && !operation.manualResolution;
}

/** B-691: what still needs the owner, and what was already handled (shown folded). */
export function attentionOperations(team: TeamState): { open: TeamState["operations"]; resolved: TeamState["operations"] } {
  const open = team.operations.filter((operation) => !operation.manualResolution && ["failed", "unknown", "claimed"].includes(operation.status));
  const resolved = team.operations.filter((operation) => !!operation.manualResolution);
  return { open, resolved };
}
