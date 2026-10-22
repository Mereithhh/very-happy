import { describe, expect, it, vi } from "vitest";
vi.mock("@/i18n/useTranslation", () => ({ useTranslation: () => ({ lang: "en" }) }));
import type { TeamTask, TeamState } from "@slopus/happy-wire";
import {
  FINISHED_PAGE_SIZE,
  finishedTasksByRecency,
  teamFinishedGroupId,
  attentionOperations,
  canReconcileOperation,
  canRetryCleanup,
  canRetryLaunch,
  machineSupportsTeamRetry,
  newestTeam,
  taskRows,
  teamOperationErrorKind,
  teamRetrySupport,
  TEAM_OPERATION_ERROR_KINDS,
} from "./teamView";
import { WORKSPACE_COPY } from "./workspaceCopy";
import { defaultCollapsed } from "@/screens/sessions/sidebarCollapsedGroups";
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
  it("does not reconcile a launch cancelled before claiming", () => {
    const team = state();
    team.operations[0].status = "failed";
    team.operations[0].error = "task_closed_before_spawn";
    team.operations[0].claimId = null;
    expect(canReconcileOperation(team, team.operations[0])).toBe(false);
  });
});

describe("B-689 launch retry entry", () => {
  const op = (patch: Partial<TeamState["operations"][number]> = {}) =>
    ({ id: "op", type: "spawn", taskId: "t", attemptId: "a1", status: "failed", claimId: "c" , ...patch }) as TeamState["operations"][number];
  const team = (status: TeamTask["status"], currentAttemptId = "a1") =>
    ({ tasks: [{ id: "t", status, currentAttemptId }] }) as unknown as TeamState;
  it("offers retry for a failed or uncertain launch of the waiting attempt only", () => {
    expect(canRetryLaunch(team("queued"), op())).toBe(true);
    expect(canRetryLaunch(team("queued"), op({ status: "unknown" }))).toBe(true);
    expect(canRetryLaunch(team("queued"), op({ status: "claimed" }))).toBe(false);
    expect(canRetryLaunch(team("queued"), op({ claimId: null }))).toBe(false);
    expect(canRetryLaunch(team("queued"), op({ type: "stop" }))).toBe(false);
    expect(canRetryLaunch(team("cancelled"), op())).toBe(false);
    expect(canRetryLaunch(team("queued", "a2"), op())).toBe(false);
  });
  it("gates the button on a daemon that acts on retry-operation", () => {
    expect(machineSupportsTeamRetry({ teamRetryVersion: 1 })).toBe(true);
    expect(machineSupportsTeamRetry({ teamLaunchVersion: 1 })).toBe(false);
    expect(machineSupportsTeamRetry(null)).toBe(false);
    expect(machineSupportsTeamRetry({ teamRetryVersion: 1 }, 2)).toBe(false);
  });
});

describe("B-691 retained cleanup entries", () => {
  const stop = (patch: Partial<TeamState["operations"][number]> = {}) =>
    ({ id: "s", type: "stop", status: "failed", claimId: "c", ...patch }) as TeamState["operations"][number];
  it("offers Retry cleanup only for a failed, unresolved stop", () => {
    expect(canRetryCleanup(stop())).toBe(true);
    expect(canRetryCleanup(stop({ status: "unknown" }))).toBe(false);
    expect(canRetryCleanup(stop({ type: "spawn" }))).toBe(false);
    expect(canRetryCleanup(stop({ claimId: null }))).toBe(false);
    expect(canRetryCleanup(stop({ manualResolution: { note: "n", at: 1 } }))).toBe(false);
  });
  it("folds handled entries away from what still needs the owner", () => {
    const ops = [stop({ id: "open" }), stop({ id: "done", status: "completed", manualResolution: { note: "pushed", at: 2 } }), stop({ id: "ok", status: "completed" }), stop({ id: "claimed", status: "claimed" })];
    const { open, resolved } = attentionOperations({ operations: ops } as TeamState);
    expect(open.map((o) => o.id)).toEqual(["open", "claimed"]);
    expect(resolved.map((o) => o.id)).toEqual(["done"]);
  });
});

describe("B-723", () => {
  const op = (extra: Record<string, unknown>) => ({ id: "o", type: "spawn", status: "failed", claimId: null, error: null, ...extra }) as unknown as TeamState["operations"][number];
  it("O2: a launch closed before it started never needs the owner", () => {
    const team = { operations: [op({ id: "closed", error: "task_closed_before_spawn" }), op({ id: "unknown", status: "unknown", claimId: "c", error: "Spawn outcome unknown; reconcile the worker before retrying" }), op({ id: "stop", type: "stop", claimId: "c", error: "task_closed_before_spawn" })] } as unknown as TeamState;
    expect(attentionOperations(team).open.map((o) => o.id)).toEqual(["unknown", "stop"]);
  });
  it("O2: daemon errors map to translated summaries; unknown text stays generic", () => {
    expect(teamOperationErrorKind("task_closed_before_spawn")).toBe("closedBeforeSpawn");
    expect(teamOperationErrorKind("Spawn outcome unknown; reconcile the worker before retrying")).toBe("outcomeUnknown");
    expect(teamOperationErrorKind("Unmerged work retained on b at /w: 2 commits are not pushed or merged; push or merge, then retry cleanup")).toBe("unmergedWork");
    expect(teamOperationErrorKind("Uncommitted work retained at /w (1 changed file): commit and push it, or discard it, then retry cleanup")).toBe("uncommittedWork");
    expect(teamOperationErrorKind("Local execution receipt missing; verify the old process before manual reconciliation")).toBe("receiptMissing");
    expect(teamOperationErrorKind("Team repository is unavailable: /r is missing or not a Git checkout. Restore the folder or delegate with an existing repository, then choose Retry launch.")).toBe("repositoryMissing");
    expect(teamOperationErrorKind("spawn x ENOENT (automatic retry 2/3 in 30s)")).toBe("startupRetrying");
    expect(teamOperationErrorKind("spawn x ENOENT (automatic retries exhausted after 3 attempts; use Retry launch after fixing the cause)")).toBe("startupExhausted");
    expect(teamOperationErrorKind("something new")).toBe("other");
    expect(teamOperationErrorKind(null)).toBeNull();
  });
  it("O2: every error kind, operation type and status has English and Chinese copy", () => {
    for (const copy of [WORKSPACE_COPY.en, WORKSPACE_COPY.zh]) {
      for (const kind of TEAM_OPERATION_ERROR_KINDS) expect(copy.opError[kind], kind).toBeTruthy();
      for (const type of ["spawn", "stop"]) expect(copy.opType[type]).toBeTruthy();
      for (const status of ["pending", "claimed", "completed", "failed", "unknown"]) expect(copy.opStatus[status]).toBeTruthy();
    }
    expect(WORKSPACE_COPY.zh.opError.outcomeUnknown).not.toMatch(/[A-Za-z]{4,}/);
  });
  it("O3: retry support is unknown until the machine and its metadata arrive", () => {
    expect(teamRetrySupport(undefined)).toBeNull();
    expect(teamRetrySupport({ metadata: null })).toBeNull();
    expect(teamRetrySupport({ metadata: { teamRetryVersion: 1 } }, 2)).toBe(false);
    expect(teamRetrySupport({ metadata: { teamRetryVersion: 2 } }, 2)).toBe(true);
  });
});

describe("B-753 finishedTasksByRecency / teamFinishedGroupId", () => {
  const t = (id: string, status: TeamTask["status"]) => ({ id, status }) as TeamTask;
  it("keeps done + cancelled, newest operation or message first, array order as the fallback", () => {
    const team = {
      tasks: [t("a", "done"), t("live", "running"), t("b", "cancelled"), t("c", "done"), t("d", "done"), t("review", "submitted")],
      operations: [{ taskId: "a", createdAt: 50 }, { taskId: "b", createdAt: 10 }, { taskId: "live", createdAt: 99 }],
      messages: [{ taskId: "b", createdAt: 70 }, { taskId: null, createdAt: 500 }],
    } as unknown as TeamState;
    // b (70) > a (50) > no timestamp: d, c (later in the array = newer)
    expect(finishedTasksByRecency(team).map(x => x.id)).toEqual(["b", "a", "d", "c"]);
  });
  it("folds by default, per team", () => {
    expect(teamFinishedGroupId("x")).toBe("team-finished:x");
    expect(defaultCollapsed(teamFinishedGroupId("x"))).toBe(true);
    expect(FINISHED_PAGE_SIZE).toBe(20);
  });
});
