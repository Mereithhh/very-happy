import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { TeamAction, TeamState } from "@slopus/happy-wire";
import { leadReviveView, useLeadReviveCopy } from "./leadRevive";

/**
 * B-945: 「负责人已停止，还有 N 个任务没收尾」+「接回负责人」on the team page. Shown
 * only while the owner can relaunch the lead (the server rule, `teamLeadReviveBlock`);
 * an offline computer or an old CLI keeps the button off and says why.
 */
export function LeadReviveNotice({ team, machine, disabled, act }: {
  team: TeamState;
  machine: { metadata?: unknown; active?: boolean } | undefined;
  disabled: boolean;
  act: (action: TeamAction) => Promise<boolean>;
}) {
  const copy = useLeadReviveCopy();
  const [sending, setSending] = useState(false);
  const view = leadReviveView(team, machine);
  if (!view) return null;
  const why = view.availability === "ready" ? null : copy[view.availability];
  return (
    <section className="team-launch-state team-lead-revive" role="alert" aria-labelledby="team-lead-revive-title" data-testid="team-lead-revive">
      <h2 id="team-lead-revive-title">{copy.title(view.open.total)}</h2>
      <p>{copy.counts(view.open)}</p>
      <p>{copy.hint}</p>
      {why && <p className="teams-error">{why}</p>}
      <button
        type="button"
        className="teams-primary"
        disabled={disabled || sending || view.availability !== "ready"}
        aria-busy={sending}
        onClick={async () => {
          setSending(true);
          try { await act({ type: "revive-lead", botId: view.lead.id }); } finally { setSending(false); }
        }}
      >
        <RotateCcw size={16} aria-hidden />{copy.button}
      </button>
    </section>
  );
}
