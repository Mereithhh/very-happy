vi.mock("@/i18n/useTranslation", () => ({ useTranslation: () => ({ lang: "en" }) }));
import { describe, expect, it, vi } from "vitest";
import { TEAM_RESTORE_WINDOW_MS, type TeamState } from "@slopus/happy-wire";
import { archivedStatusLine, restoreConflicts, TEAM_RESTORE_COPY, teamRestoreView } from "./teamRestore";

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
