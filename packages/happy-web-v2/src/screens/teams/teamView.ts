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

/** B-723 (O3): retry support is unknown (`null`) until the execution machine
 *  and its metadata have loaded — never 「update the CLI」 for a page that
 *  simply has not received them yet. */
export function teamRetrySupport(machine: { metadata?: unknown } | undefined, version = 1): boolean | null {
  if (!machine || machine.metadata == null) return null;
  return machineSupportsTeamRetry(machine.metadata, version);
}

/** B-691: a retained cleanup the owner can ask the computer to re-check now. */
export function canRetryCleanup(operation: TeamState["operations"][number]): boolean {
  return operation.type === "stop" && operation.status === "failed" && !!operation.claimId && !operation.manualResolution;
}

/** B-723 (O2): a launch whose task closed before it started never ran —
 *  nothing to clean up or reconcile (the server lets its member be reused,
 *  reducer `bot_has_unresolved_operations`), so it never needs the owner. */
export function closedBeforeSpawn(operation: TeamState["operations"][number]): boolean {
  return operation.type === "spawn" && operation.status === "failed" && operation.error === "task_closed_before_spawn";
}

/** B-691: what still needs the owner, and what was already handled (shown folded). */
export function attentionOperations(team: TeamState): { open: TeamState["operations"]; resolved: TeamState["operations"] } {
  const open = team.operations.filter((operation) => !operation.manualResolution && ["failed", "unknown", "claimed"].includes(operation.status) && !closedBeforeSpawn(operation));
  const resolved = team.operations.filter((operation) => !!operation.manualResolution);
  return { open, resolved };
}

/**
 * B-723 (O2): the daemon reports team operation failures as English prose or
 * internal codes (happy-cli daemon/teams/worker.ts, worktree.ts,
 * spawnRetry.ts). The page shows a translated summary for the known ones and
 * keeps the raw text for the folded 「详情」.
 */
export const TEAM_OPERATION_ERROR_KINDS = [
  "closedBeforeSpawn", "outcomeUnknown", "receiptMissing", "uncommittedWork", "unmergedWork",
  "repositoryMissing", "noRepository", "worktreeConflict", "brokenWorktree", "bindingChanged",
  "ownershipUnknown", "directoryApproval", "startupRetrying", "startupExhausted", "other",
] as const;
export type TeamOperationErrorKind = (typeof TEAM_OPERATION_ERROR_KINDS)[number];

export function teamOperationErrorKind(error: string | null | undefined): TeamOperationErrorKind | null {
  if (!error) return null;
  if (error === "task_closed_before_spawn") return "closedBeforeSpawn";
  if (error.startsWith("Spawn outcome unknown")) return "outcomeUnknown";
  if (error.startsWith("Local execution receipt missing")) return "receiptMissing";
  if (error.startsWith("Uncommitted work retained")) return "uncommittedWork";
  if (error.startsWith("Unmerged work retained")) return "unmergedWork";
  if (error.startsWith("Team repository is unavailable") || error.startsWith("Team repository is missing")) return "repositoryMissing";
  if (error.startsWith("No repository selected")) return "noRepository";
  if (error.startsWith("Team worktree path is occupied") || error.startsWith("Team worktree belongs to another repository") || error.startsWith("Worktree repository changed")) return "worktreeConflict";
  if (error.includes("is registered as a worktree but its git link is broken")) return "brokenWorktree";
  if (error.startsWith("Worker binding changed")) return "bindingChanged";
  if (error.startsWith("Original worktree ownership is unknown") || error.startsWith("Original worktree receipt is missing")) return "ownershipUnknown";
  if (error === "Directory approval required") return "directoryApproval";
  if (/\(automatic retry \d+\/\d+ in \d+s\)$/.test(error)) return "startupRetrying";
  if (/\(automatic retries exhausted after \d+ attempts?; use Retry launch after fixing the cause\)$/.test(error)) return "startupExhausted";
  return "other";
}

/** B-753: the 「已结束」 lane (done + cancelled) folds by default; this is its
 *  device-local key in sidebarCollapsedGroups (default collapsed there). */
export function teamFinishedGroupId(teamId: string): string {
  return `team-finished:${teamId}`;
}

/** B-753: an open 「已结束」 lane shows this many cards, then 「显示更多」 adds as many again. */
export const FINISHED_PAGE_SIZE = 20;

/**
 * B-753: finished tasks (done / cancelled), most recent first. Tasks carry no
 * timestamps, so recency is the newest operation or message about the task
 * (its cleanup `stop`, the submit / accept messages); tasks with neither, and
 * ties, fall back to array order — the server appends, so later is newer.
 */
export function finishedTasksByRecency(team: Pick<TeamState, "tasks" | "operations" | "messages">): TeamTask[] {
  const last = new Map<string, number>();
  const note = (taskId: string | null | undefined, at: number) => {
    if (taskId && at > (last.get(taskId) ?? -Infinity)) last.set(taskId, at);
  };
  for (const op of team.operations) note(op.taskId, op.createdAt);
  for (const msg of team.messages) note(msg.taskId, msg.createdAt);
  return team.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === "done" || task.status === "cancelled")
    .sort((a, b) => (last.get(b.task.id) ?? -Infinity) - (last.get(a.task.id) ?? -Infinity) || b.index - a.index)
    .map(({ task }) => task);
}
