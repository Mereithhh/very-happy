import { describe, expect, it } from "vitest";
import type { TeamTask, TeamState } from "@slopus/happy-wire";
import { newestTeam, taskRows } from "./teamView";
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
