import type { ReactNode } from "react";
import type { TeamState, TeamTask } from "@slopus/happy-wire";
import { t as tr } from "@/text";
import { taskLaunchIssue } from "./teamPresentation";
import { useFirstUseCopy } from "./firstUseCopy";
import { useWorkspaceCopy } from "./workspaceCopy";
import { OperationError } from "./OperationError";
import { useTranslation } from "@/i18n/useTranslation";

/** B-728 (UI-P1-15): CJK labels take the full-width colon, every other language ": ". */
export function labelColon(lang: string): string {
  return /^(zh|ja)/.test(lang) ? "：" : ": ";
}

export const taskStatus = (): Record<string, string> => ({
  queued: tr("teams.queued"),
  running: tr("teams.running"),
  submitted: tr("teams.submitted"),
  done: tr("teams.done"),
  cancelled: tr("teams.cancelled"),
});

/** Task details dialog, read-only head. B-687: goal and acceptance keep their line breaks (`.teams-multiline`). */
export function TeamTaskSummary({ team, task, launchIssue }: { team: TeamState; task: TeamTask; launchIssue?: (issue: TeamState["operations"][number]) => ReactNode }) {
  const c = useWorkspaceCopy();
  const first = useFirstUseCopy();
  const colon = labelColon(useTranslation().lang);
  const issue = taskLaunchIssue(team, task);
  const parent = task.parentTaskId ? team.tasks.find((p) => p.id === task.parentTaskId) : undefined;
  return <>
    <div className="teams-row">
      <strong className="teams-multiline">{task.goal}</strong>
      <span data-live={task.status === "running"}>{issue ? first.launchFailed : taskStatus()[task.status]}</span>
    </div>
    {/* B-689: the screen supplies the actionable block (Retry launch); this is the read-only fallback. */}
    {issue && (launchIssue ? launchIssue(issue) : <div className="teams-error" role="alert"><strong>{first.launchFailed}</strong><OperationError error={issue.error} /><p>{issue.status === "unknown" ? first.unknownHint : first.retryHint}</p></div>)}
    {/* The parent is a reference: its first line, like the board's parent label. */}
    {task.parentTaskId && <p>{tr("teams.parent")}{colon}{parent?.goal.split("\n")[0] ?? task.parentTaskId}</p>}
    <p>
      {tr("teams.assignee")}{colon}{team.bots.find((b) => b.id === task.assigneeBotId)?.name ?? task.assigneeBotId}{" "}
      · {tr("teams.cleanup")}{colon}{task.cleanup === "done" ? c.cleanupDone : task.cleanup === "failed" ? c.cleanupFailed : task.cleanup === "pending" ? c.cleanupPending : c.cleanupNone}
    </p>
    <ul>{task.acceptance.map((a, i) => <li key={i} className="teams-multiline">{a}</li>)}</ul>
  </>;
}

/** The task's last five team messages, bodies with their line breaks. */
export function TeamTaskMessages({ team, task }: { team: TeamState; task: TeamTask }) {
  return <>
    {team.messages.filter((m) => m.taskId === task.id).slice(-5).map((m) => (
      <p key={m.id}>
        <span className="teams-multiline">{m.body}</span>{" "}
        <small>{m.deliveredAt ? tr("teams.delivered") : tr("teams.waitingDelivery")}</small>
      </p>
    ))}
  </>;
}
