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

/** Presentation preflight only; server rechecks these conditions atomically. */
export function archiveBlocker(
  team: TeamState,
): "activeTasks" | "unresolvedOperations" | "cleanupUnfinished" | null {
  if (team.tasks.some((task) => !["done", "cancelled"].includes(task.status)))
    return "activeTasks";
  if (
    team.operations.some(
      (operation) =>
        ["pending", "claimed", "unknown"].includes(operation.status) ||
        (operation.status === "failed" &&
          operation.error !== "task_closed_before_spawn"),
    )
  )
    return "unresolvedOperations";
  if (team.tasks.some((task) => ["pending", "failed"].includes(task.cleanup)))
    return "cleanupUnfinished";
  return null;
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
