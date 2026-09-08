import type { TeamTask } from "@slopus/happy-wire";
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
