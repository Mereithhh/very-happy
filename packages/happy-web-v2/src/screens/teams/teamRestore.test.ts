vi.mock("@/i18n/useTranslation", () => ({ useTranslation: () => ({ lang: "en" }) }));
import { describe, expect, it, vi } from "vitest";
import { TEAM_RESTORE_WINDOW_MS, type TeamState } from "@slopus/happy-wire";
import { archivedStatusLine, restoreConflicts, TEAM_RESTORE_COPY, teamRestoreResult, teamRestoreView } from "./teamRestore";

const at = 1_000_000;
const archived = (over: Partial<TeamState> = {}): TeamState => ({
  id: "t", name: "T", machineId: "m", version: 1, createdAt: 1, archivedAt: at, messages: [], operations: [], bots: [],
  tasks: [
    { id: "a", parentTaskId: null, goal: "g", acceptance: ["x"], goalVersion: 1, ownerBotId: null, assigneeBotId: "lead", status: "cancelled", closedAt: at, attempts: [], currentAttemptId: "x", cleanup: "none" },
    { id: "done", parentTaskId: null, goal: "g", acceptance: ["x"], goalVersion: 1, ownerBotId: null, assigneeBotId: "lead", status: "done", closedAt: at - 5, attempts: [], currentAttemptId: "y", cleanup: "none" },
  ],
  ...over,
});
const machine = { active: true, metadata: { teamRestoreVersion: 1 } };

describe("B-962 restore view", () => {
  it("counts what an archive before B-962 cancelled (closedAt == archivedAt) and is ready on a current daemon", () => {
    expect(teamRestoreView(archived(), machine, at + 1000)).toMatchObject({ tasks: 1, schedules: 0, messages: 0, daysLeft: 7, source: "unknown", availability: "ready" });
  });
  it("names the recorded source and uses the recorded list", () => {
    const team = archived({ archive: { at, source: "web", by: "owner-login", restorable: { tasks: [], schedules: [{ id: "s", status: "active", nextRunAt: 5 }], messageIds: ["m1", "m2"] } } });
    expect(teamRestoreView(team, machine, at)).toMatchObject({ tasks: 0, schedules: 1, messages: 2, source: "web" });
  });
  it("says why it cannot restore: expired, old CLI, offline, unknown machine; null for a live team", () => {
    expect(teamRestoreView(archived(), machine, at + TEAM_RESTORE_WINDOW_MS + 1)?.availability).toBe("expired");
    expect(teamRestoreView(archived(), { active: true, metadata: { teamLaunchVersion: 1 } }, at)?.availability).toBe("upgrade");
    expect(teamRestoreView(archived(), { active: false, metadata: { teamRestoreVersion: 1 } }, at)?.availability).toBe("offline");
    expect(teamRestoreView(archived(), undefined, at)?.availability).toBe("loading");
    expect(teamRestoreView(archived({ archivedAt: undefined }), machine, at)).toBeNull();
  });
  it("reads the conflicts of a restore_conflict refusal, ignoring junk", () => {
    const c = { botId: "b", botName: "Dev", root: false, sessionId: "s", teamId: "o", teamName: "Other" };
    expect(restoreConflicts({ conflicts: [c, null, { x: 1 }] })).toEqual([c]);
    expect(restoreConflicts(undefined)).toEqual([]);
  });
  it("the skip choice says the original conversation is not taken (both languages)", () => {
    expect(TEAM_RESTORE_COPY.zh.conflictHint).toContain("原来的会话不动");
    expect(TEAM_RESTORE_COPY.en.conflictHint).toContain("untouched");
    expect(Object.keys(TEAM_RESTORE_COPY.zh).sort()).toEqual(Object.keys(TEAM_RESTORE_COPY.en).sort());
  });
});

describe("B-962: the machine's restore capability survives the Web's metadata parse", () => {
  it("MachineMetadataSchema keeps teamRestoreVersion (an unknown key would be stripped and every restore read as an old CLI)", async () => {
    const { MachineMetadataSchema } = await import("@/sync/storageTypes");
    const parsed = MachineMetadataSchema.parse({ host: "h", platform: "linux", happyCliVersion: "1", happyHomeDir: "/h", homeDir: "/h", teamLaunchVersion: 1, teamRestoreVersion: 1 });
    expect(teamRestoreView(archived(), { active: true, metadata: parsed }, at)?.availability).toBe("ready");
  });
  it("B-962b: the heading says restorable-until within the window, read-only past it (both languages)", () => {
    const fmt = (ms: number) => `T${ms}`;
    const until = `T${at + TEAM_RESTORE_WINDOW_MS}`;
    expect(archivedStatusLine(archived(), at + 1000, TEAM_RESTORE_COPY.zh, "团队已归档，仅可查看", fmt)).toBe(`已归档 · 可恢复（截至 ${until}）`);
    expect(archivedStatusLine(archived(), at + TEAM_RESTORE_WINDOW_MS, TEAM_RESTORE_COPY.en, "read-only", fmt)).toBe(`Archived · restorable until ${until}`);
    expect(archivedStatusLine(archived(), at + TEAM_RESTORE_WINDOW_MS + 1, TEAM_RESTORE_COPY.zh, "团队已归档，仅可查看", fmt)).toBe(`团队已归档，仅可查看 · T${at}`);
    expect(archivedStatusLine(archived(), at + TEAM_RESTORE_WINDOW_MS + 1, TEAM_RESTORE_COPY.en, "This team is archived and read-only", fmt)).toBe(`This team is archived and read-only · T${at}`);
    expect(archivedStatusLine(archived({ archivedAt: undefined }), at, TEAM_RESTORE_COPY.en, "x", fmt)).toBeNull();
  });
});

describe("B-962c restore result on the live team page", () => {
  const restoredAt = at + 5000;
  const bots = [
    { id: "lead", name: "Lead", root: true }, { id: "a", name: "Alice", root: false }, { id: "b", name: "Bob", root: false },
  ] as TeamState["bots"];
  const op = (botId: string, over: Partial<TeamState["operations"][number]> = {}) => ({
    id: `op-${botId}`, teamId: "t", machineId: "m", taskId: "a", botId, attemptId: "x", generation: 2, type: "spawn" as const, status: "pending" as const,
    claimId: null, claimedAt: null, error: null, sessionId: null, directory: null, assistant: "claude" as const, prompt: "", createdAt: restoredAt,
    restoreVersion: 1 as const, resumeSessionId: `s-${botId}`, ...over,
  });
  const live = (operations: TeamState["operations"]): TeamState => ({ ...archived({ archivedAt: undefined, archiveHistory: [{ at, source: "web", by: "owner-login", restoredAt }] }), bots, operations });

  it("R77: the lead hit restart-limit on the second restore — the page names it and why, never says all continued", () => {
    const team = live([
      op("lead", { status: "completed", sessionId: "s-new", restoreFallback: "restart:restart-limit: max 3" }),
      op("a", { status: "completed", sessionId: "s-a" }),
      op("b", { status: "completed", sessionId: "s-b" }),
    ]);
    const r = teamRestoreResult(team, restoredAt + 1000)!;
    expect(r.allContinued).toBe(false);
    expect(r.notContinued).toEqual([expect.objectContaining({ botId: "lead", root: true, state: "fresh", kind: "restart-limit" })]);
    expect(TEAM_RESTORE_COPY.zh.reasons["restart-limit"]).toContain("重启次数");
  });
  it("pending launches are counted; all continued is said only once everyone did, and only for a while", () => {
    const pending = live([op("lead", { status: "completed", sessionId: "s-lead" }), op("a")]);
    expect(teamRestoreResult(pending, restoredAt)).toMatchObject({ pending: 1, total: 2, allContinued: false, notContinued: [] });
    const done = live([op("lead", { status: "completed", sessionId: "s-lead" }), op("a", { status: "completed", sessionId: "s-a" })]);
    expect(teamRestoreResult(done, restoredAt)).toMatchObject({ allContinued: true });
    expect(teamRestoreResult(done, restoredAt + 11 * 60_000)).toBeNull();
    // A member that started fresh stays listed for a day.
    const fresh = live([op("a", { status: "completed", sessionId: "other" })]);
    expect(teamRestoreResult(fresh, restoredAt + 11 * 60_000)?.notContinued[0]).toMatchObject({ state: "fresh", kind: "other" });
    expect(teamRestoreResult(fresh, restoredAt + 25 * 3600_000)).toBeNull();
  });
  it("a skipped member (conflict) is fresh at once; the copy never claims every member continues", () => {
    const team = live([op("b", { resumeSessionId: undefined, restoreFallback: "conflict: its conversation is in another team now" })]);
    expect(teamRestoreResult(team, restoredAt)!.notContinued[0]).toMatchObject({ state: "fresh", kind: "conflict" });
    for (const copy of [TEAM_RESTORE_COPY.en, TEAM_RESTORE_COPY.zh]) {
      expect(copy.restored).not.toMatch(/continuing their conversations|正在接着原来的对话继续/);
      expect(copy.restoredSkipped("Bob")).toContain("Bob");
    }
    expect(TEAM_RESTORE_COPY.zh.restoredSkipped("Bob")).toContain("新起会话");
  });
  it("no result for an archived or never-restored team", () => {
    expect(teamRestoreResult(archived(), at)).toBeNull();
    expect(teamRestoreResult(archived({ archivedAt: undefined }), at)).toBeNull();
  });
});
