import { describe, expect, it } from "vitest";
import type { TeamTask, TeamState } from "@slopus/happy-wire";
import {
  archiveBlocker,
  canReconcileOperation,
  newestTeam,
  taskRows,
} from "./teamView";
const task = (id: string, parentTaskId: string | null) =>
  ({ id, parentTaskId }) as TeamTask;
describe("team task tree", () => {
  it("orders parents before children even when child arrives first", () => {
    expect(
      taskRows([
        task("child", "root"),
        task("root", null),
        task("other", null),
      ]).map((r) => [r.task.id, r.depth]),
    ).toEqual([
      ["root", 0],
      ["child", 1],
      ["other", 0],
    ]);
  });
  it("keeps orphan and cyclic work visible exactly once", () => {
    const rows = taskRows([
      task("a", "b"),
      task("b", "a"),
      task("orphan", "missing"),
    ]);
    expect(rows.map((r) => r.task.id).sort()).toEqual(["a", "b", "orphan"]);
  });
});

describe("team response ordering", () => {
  it("does not regress after a slow read or old idempotent replay", () => {
    const current = { id: "one", version: 4 } as TeamState;
    expect(newestTeam(current, { id: "one", version: 3 } as TeamState)).toBe(
      current,
    );
    expect(
      newestTeam(current, { id: "one", version: 5 } as TeamState).version,
    ).toBe(5);
  });
});

describe("team lifecycle action availability", () => {
  const state = (): TeamState =>
    ({
      id: "team",
      version: 1,
      tasks: [
        {
          id: "task",
          status: "cancelled",
          cleanup: "done",
          attempts: [{ id: "attempt", status: "cancelled" }],
        },
      ],
      operations: [
        {
          id: "operation",
          taskId: "task",
          attemptId: "attempt",
          status: "unknown",
          claimId: "claim",
          error: null,
        },
      ],
    }) as TeamState;
  it("requires a claimed closed or superseded execution for manual reconciliation", () => {
    const team = state();
    const operation = team.operations[0];
    expect(canReconcileOperation(team, operation)).toBe(true);
    team.tasks[0].status = "running";
    expect(canReconcileOperation(team, operation)).toBe(false);
    team.tasks[0].attempts[0].status = "superseded";
    expect(canReconcileOperation(team, operation)).toBe(true);
    operation.claimId = null;
    expect(canReconcileOperation(team, operation)).toBe(false);
    operation.claimId = "claim";
    operation.status = "pending";
    expect(canReconcileOperation(team, operation)).toBe(false);
  });
  it("keeps archive blocked until operations and cleanup resolve", () => {
    const team = state();
    expect(archiveBlocker(team)).toBe("unresolvedOperations");
    team.operations[0].status = "completed";
    team.tasks[0].cleanup = "pending";
    expect(archiveBlocker(team)).toBe("cleanupUnfinished");
    team.tasks[0].cleanup = "done";
    team.tasks[0].status = "running";
    expect(archiveBlocker(team)).toBe("activeTasks");
    team.tasks[0].status = "done";
    expect(archiveBlocker(team)).toBeNull();
  });
  it("allows archive after cancellation prevented spawning without a claim", () => {
    const team = state();
    team.operations[0].status = "failed";
    team.operations[0].error = "task_closed_before_spawn";
    team.operations[0].claimId = null;
    expect(archiveBlocker(team)).toBeNull();
    expect(canReconcileOperation(team, team.operations[0])).toBe(false);
  });
});

it('keeps archive blocked for active and paused schedules', () => {
  const team = {tasks:[],operations:[],schedules:[{status:'active'}]} as unknown as TeamState;
  expect(archiveBlocker(team)).toBe('activeSchedules');
  team.schedules![0].status='paused';expect(archiveBlocker(team)).toBe('activeSchedules');
  team.schedules![0].status='cancelled';expect(archiveBlocker(team)).toBeNull();
});
