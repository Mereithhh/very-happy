import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ machines: {} as Record<string, unknown>, rpc: vi.fn(), confirm: vi.fn(async () => true), error: vi.fn(), success: vi.fn() }));
vi.mock("@/sync/apiSocket", () => ({ apiSocket: { machineRPC: h.rpc } }));
vi.mock("@/modal", () => ({ Modal: { confirm: h.confirm } }));
vi.mock("@/ui/Toast", () => ({ toast: { error: h.error, success: h.success } }));
vi.mock("@/text", () => ({ t: (key: string) => key }));
vi.mock("@/screens/sessions/useTeamNavigation", () => ({ refreshTeamNavigation: () => Promise.resolve() }));
vi.mock("@/sync/storage", () => ({ storage: { getState: () => ({ machines: h.machines }) } }));
import type { TeamState } from "@slopus/happy-wire";
import { confirmExitTeamMode, teamExitOutcome, teamExitSupported, teamExitTarget, teamLeadSessionId } from "./teamExit";

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
  it("B-877b (QA49 P2-2): an older daemon reads as an old CLI, whether it or the server answers", () => {
    // The server, when no daemon registered the method (it waited 15 s first).
    expect(teamExitOutcome(undefined, new Error("RPC method not available"))).toMatchObject({ ok: false, message: "teams.exitTeamModeOldCli" });
    expect(teamExitOutcome({ error: "RPC method not available" })).toMatchObject({ ok: false, message: "teams.exitTeamModeOldCli" });
    // A daemon that advertised the method but is not connected is offline, not old.
    expect(teamExitOutcome(undefined, new Error("RPC method not available"), true)).toMatchObject({ ok: false, message: "teams.exitTeamModeOffline" });
    expect(teamExitOutcome(undefined, new Error("Method not found"), true)).toMatchObject({ ok: false, message: "teams.exitTeamModeOldCli" });
  });
  it("B-877b: only a daemon that stamped teamExit this run counts as supporting it (asked before the RPC)", () => {
    expect(teamExitSupported({ startedAt: 10, teamExit: { rpcAvailable: true, detectedAt: 10 } })).toBe(true);
    expect(teamExitSupported({ startedAt: 10 })).toBe(false);
    expect(teamExitSupported({ startedAt: 20, teamExit: { rpcAvailable: true, detectedAt: 10 } })).toBe(false);
    expect(teamExitSupported(undefined)).toBe(false);
  });
  it("B-877b: an older lead CLI is told at once — no confirm, no RPC, no 15 s wait", async () => {
    h.machines = { old: { daemonState: { startedAt: 10 } }, cur: { daemonState: { startedAt: 10, teamExit: { rpcAvailable: true, detectedAt: 10 } } } };
    h.rpc.mockReset(); h.confirm.mockClear(); h.error.mockClear(); h.success.mockClear();
    expect(await confirmExitTeamMode("old", "s-lead")).toBe(false);
    expect(h.error).toHaveBeenCalledWith("teams.exitTeamModeOldCli");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    h.rpc.mockResolvedValueOnce({ teamId: "t", restarted: true });
    expect(await confirmExitTeamMode("cur", "s-lead")).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith("cur", "team-exit-session", { sessionId: "s-lead" }, { timeoutMs: 30_000 });
    expect(h.success).toHaveBeenCalledWith("teams.exitTeamModeDone");
  });
});
