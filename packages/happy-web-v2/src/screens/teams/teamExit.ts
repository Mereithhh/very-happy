import type { TeamState } from "@slopus/happy-wire";
import { apiSocket } from "@/sync/apiSocket";
import { Modal } from "@/modal";
import { toast } from "@/ui/Toast";
import { t } from "@/text";
import { refreshTeamNavigation } from "@/screens/sessions/useTeamNavigation";
import { storage } from "@/sync/storage";
import { daemonRpcFlagSupported } from "@/sync/closedTerminals";

/**
 * B-877 「退出团队模式」: a lead session goes on as an ordinary one. The lead's daemon
 * archives the team with `keepLeadSession` (members stop, worktrees stay), forgets the
 * session's team scope and restarts a Teams-spawned wrapper in place (history kept).
 * It runs on the daemon because only that machine holds the scope and the process.
 */

/** The live team this session leads, with the lead's session id. Members and archived teams: null. */
export function teamExitTarget(teams: readonly TeamState[], sessionId: string): { team: TeamState; sessionId: string } | null {
  for (const team of teams) {
    if (team.archivedAt !== undefined) continue;
    if (team.bots.some((bot) => bot.root && bot.sessionId === sessionId)) return { team, sessionId };
  }
  return null;
}

/** The team's lead session, for the team page's menu (null while none is bound). */
export function teamLeadSessionId(team: TeamState): string | null {
  return team.bots.find((bot) => bot.root && bot.sessionId)?.sessionId ?? null;
}

export type TeamExitReply = { teamId?: string; restarted?: boolean; leadStopped?: boolean } | { error: string };
export type TeamExitOutcome =
  | { ok: true; message: "teams.exitTeamModeDone" | "teams.exitTeamModeDoneNoRestart" | "teams.exitTeamModeLeadStopped" }
  | { ok: false; message: "teams.exitTeamModeOffline" | "teams.exitTeamModeOldCli" | null; detail: string };

/**
 * B-877b (QA49 P2-2): does the lead machine's CURRENT daemon answer `team-exit-session`? An older one
 * never registered it, so the server waits its 15 s reconnect grace and answers "RPC method not
 * available"; the web asks for a CLI update at once instead.
 */
export function teamExitSupported(daemonState: unknown): boolean {
  return daemonRpcFlagSupported(daemonState, "teamExit");
}

/**
 * RPC reply or transport error → what the person is told. An RPC resolve can still carry `{ error }` (AGENTS #17).
 * `supported`: the daemon advertised `team-exit-session`, so a missing method means it is not connected.
 */
export function teamExitOutcome(reply: TeamExitReply | undefined, thrown?: unknown, supported = false): TeamExitOutcome {
  const error = thrown !== undefined ? (thrown instanceof Error ? thrown.message : String(thrown)) : reply && "error" in reply ? reply.error : null;
  if (error !== null) {
    const lower = error.toLowerCase();
    // The daemon's own "Method not found", or the server's "RPC method not available" when no daemon registered it.
    if (lower.includes("method not found") || lower.includes("method not available")) {
      return { ok: false, message: supported && lower.includes("not available") ? "teams.exitTeamModeOffline" : "teams.exitTeamModeOldCli", detail: error };
    }
    if (lower.includes("machine_offline") || lower.includes("offline")) return { ok: false, message: "teams.exitTeamModeOffline", detail: error };
    return { ok: false, message: null, detail: error };
  }
  const done = reply as { restarted?: boolean; leadStopped?: boolean } | undefined;
  if (done?.leadStopped) return { ok: true, message: "teams.exitTeamModeLeadStopped" };
  return { ok: true, message: done?.restarted ? "teams.exitTeamModeDone" : "teams.exitTeamModeDoneNoRestart" };
}

/** Confirm, run on the lead's machine, report. Resolves true when the session left team mode. */
export async function confirmExitTeamMode(machineId: string | null | undefined, sessionId: string): Promise<boolean> {
  const daemonState = machineId ? storage.getState().machines[machineId]?.daemonState : undefined;
  const supported = teamExitSupported(daemonState);
  // A known daemon without the flag is an older CLI: say so now, before the confirm (no 15 s wait, no raw error).
  if (daemonState && !supported) {
    toast.error(t("teams.exitTeamModeOldCli"));
    return false;
  }
  if (!await Modal.confirm(t("teams.exitTeamMode"), t("teams.exitTeamModeDescription"), { confirmText: t("teams.exitTeamMode"), destructive: true })) return false;
  let outcome: TeamExitOutcome;
  if (!machineId) outcome = { ok: false, message: "teams.exitTeamModeOffline", detail: "no machine" };
  else {
    try {
      outcome = teamExitOutcome(await apiSocket.machineRPC<TeamExitReply, { sessionId: string }>(machineId, "team-exit-session", { sessionId }, { timeoutMs: 30_000 }), undefined, supported);
    } catch (error) {
      outcome = teamExitOutcome(undefined, error, supported);
    }
  }
  void refreshTeamNavigation();
  if (outcome.ok) toast.success(t(outcome.message));
  else toast.error(outcome.message ? t(outcome.message) : `${t("teams.exitTeamMode")}: ${outcome.detail}`);
  return outcome.ok;
}
