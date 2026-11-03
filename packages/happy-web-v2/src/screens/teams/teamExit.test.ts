import { describe, expect, it, vi } from "vitest";
vi.mock("@/sync/apiSocket", () => ({ apiSocket: {} }));
vi.mock("@/modal", () => ({ Modal: {} }));
vi.mock("@/ui/Toast", () => ({ toast: {} }));
vi.mock("@/text", () => ({ t: (key: string) => key }));
vi.mock("@/screens/sessions/useTeamNavigation", () => ({ refreshTeamNavigation: () => Promise.resolve() }));
import type { TeamState } from "@slopus/happy-wire";
import { teamExitOutcome, teamExitTarget, teamLeadSessionId } from "./teamExit";

const team = (over: Partial<TeamState> = {}): TeamState => ({ id: "t", name: "T", machineId: "m", version: 1, createdAt: 1, tasks: [], messages: [], operations: [], bots: [
  { id: "lead", name: "Lead", root: true, managed: true, sessionId: "s-lead", generation: 1, assistant: "claude", directory: null },
  { id: "m", name: "Dev", root: false, managed: true, sessionId: "s-member", generation: 1, assistant: "claude", directory: null },
] as TeamState["bots"], ...over });

describe("B-877 exit team mode", () => {
  it("is offered only to the lead of a live team", () => {
    expect(teamExitTarget([team()], "s-lead")?.team.id).toBe("t");
    expect(teamExitTarget([team()], "s-member")).toBeNull();
    expect(teamExitTarget([team({ archivedAt: 5 })], "s-lead")).toBeNull();
    expect(teamExitTarget([], "s-lead")).toBeNull();
    expect(teamLeadSessionId(team())).toBe("s-lead");
  });
  it("maps the daemon reply, including a resolved { error } and old or offline machines", () => {
    expect(teamExitOutcome({ teamId: "t", restarted: true })).toEqual({ ok: true, message: "teams.exitTeamModeDone" });
    expect(teamExitOutcome({ teamId: "t", restarted: false })).toEqual({ ok: true, message: "teams.exitTeamModeDoneNoRestart" });
    expect(teamExitOutcome({ teamId: "t", leadStopped: true })).toEqual({ ok: true, message: "teams.exitTeamModeLeadStopped" });
    expect(teamExitOutcome({ error: "Only the team lead session can exit team mode" })).toMatchObject({ ok: false, message: null });
    expect(teamExitOutcome(undefined, new Error("Method not found"))).toMatchObject({ ok: false, message: "teams.exitTeamModeOldCli" });
    expect(teamExitOutcome(undefined, new Error("machine_offline"))).toMatchObject({ ok: false, message: "teams.exitTeamModeOffline" });
  });
});
