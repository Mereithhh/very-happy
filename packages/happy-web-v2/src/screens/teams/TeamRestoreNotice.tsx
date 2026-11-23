import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { TeamState } from "@slopus/happy-wire";
import { Modal } from "@/modal";
import { toast } from "@/ui/Toast";
import { actOnTeam, TeamsApiError } from "@/sync/teams";
import { refreshTeamNavigation } from "@/screens/sessions/useTeamNavigation";
import { restoreConflicts, teamRestoreView, useTeamRestoreCopy, type TeamRestoreConflict } from "./teamRestore";

/**
 * B-962: the archived team page's 「这个团队已归档」+「恢复团队」. A member whose conversation another live
 * team holds now is never taken from it: the owner restores without it (that member starts fresh).
 */
export function TeamRestoreNotice({ team, machine, onRestored }: {
  team: TeamState;
  machine: { metadata?: unknown; active?: boolean } | undefined;
  onRestored: () => void;
}) {
  const copy = useTeamRestoreCopy();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<TeamRestoreConflict[]>([]);
  const view = teamRestoreView(team, machine, Date.now());
  if (!view) return null;
  const why = view.availability === "ready" ? null : copy[view.availability];
  async function restore(skip?: string[]) {
    if (!skip && !await Modal.confirm(copy.confirmTitle, copy.confirmBody, { confirmText: copy.button })) return;
    setSending(true); setError("");
    try {
      await actOnTeam(team.id, { type: "restore", ...(skip?.length ? { skipBotIds: skip } : {}) }, crypto.randomUUID());
      setConflicts([]);
      toast.success(copy.restored);
      void refreshTeamNavigation();
      onRestored();
    } catch (e) {
      if (e instanceof TeamsApiError && e.code === "restore_conflict") setConflicts(restoreConflicts(e.details));
      else setError(e instanceof TeamsApiError ? copy.refusals[e.code] ?? e.code : e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }
  return (
    <section className="team-launch-state team-restore" role="status" aria-labelledby="team-restore-title" data-testid="team-restore">
      <h2 id="team-restore-title">{copy.title}</h2>
      <p>{copy.counts(view)} {copy.source[view.source]}</p>
      {view.availability !== "expired" && <p>{copy.hint(view.daysLeft)}</p>}
      {why && <p className="teams-error">{why}</p>}
      {error && <p className="teams-error" role="alert">{error}</p>}
      {conflicts.length > 0 ? (
        <div className="team-restore-conflicts" role="alert" data-testid="team-restore-conflicts">
          <h3>{copy.conflictTitle}</h3>
          <ul>{conflicts.map(c => <li key={c.botId}>{copy.conflictItem(c)}</li>)}</ul>
          <p>{copy.conflictHint}</p>
          <div className="team-restore-actions">
            <button type="button" className="teams-primary" disabled={sending} aria-busy={sending} onClick={() => void restore(conflicts.map(c => c.botId))}>{copy.conflictSkip}</button>
            <button type="button" disabled={sending} onClick={() => setConflicts([])}>{copy.conflictCancel}</button>
          </div>
        </div>
      ) : view.availability !== "expired" && (
        <button type="button" className="teams-primary" disabled={sending || view.availability !== "ready"} aria-busy={sending} onClick={() => void restore()}>
          <RotateCcw size={16} aria-hidden />{copy.button}
        </button>
      )}
    </section>
  );
}
