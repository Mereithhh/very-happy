/**
 * B-945: a lead with open delegations is never accepted away, and a lead that
 * already was (accepted root task → stopped, worktree removed) can be brought
 * back from the team page (`revive-lead`). The rules live in happy-wire
 * (`teamOwnedOpenTasks`, `teamLeadReviveBlock`); this file is the page's view of them.
 */
import { TEAM_OWNED_TASKS_UNFINISHED, teamLeadReviveBlock, teamManagedLead, teamOwnedOpenTasks, type TeamBot, type TeamOwnedOpenTasks, type TeamState, type TeamTask } from "@slopus/happy-wire";
import { useTranslation } from "@/i18n/useTranslation";

/** The open tasks a submitted task's assignee still owns — accepting it would stop that assignee. Null when none. */
export function acceptBlockedByOpenTasks(team: Pick<TeamState, "tasks">, task: Pick<TeamTask, "status" | "assigneeBotId">): TeamOwnedOpenTasks | null {
  if (task.status !== "submitted") return null;
  const open = teamOwnedOpenTasks(team, task.assigneeBotId);
  return open.total > 0 ? open : null;
}

/** How many open tasks a refusal names (`owned_tasks_unfinished`), or null for any other refusal. */
export function ownedTasksRefusalCount(error: { code?: unknown; details?: unknown } | null | undefined): number | null {
  if (!error || error.code !== TEAM_OWNED_TASKS_UNFINISHED) return null;
  const n = (error.details as { openTasks?: unknown } | undefined)?.openTasks;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

type MachineLike = { metadata?: unknown; active?: boolean; activeAt?: number } | undefined;

/**
 * The team page's「接回负责人」state. `null` = nothing to show (the lead is running,
 * or nothing is left for it). `ready` = the owner can click; `offline` / `upgrade` /
 * `loading` say why not yet (never a silent failure, like Retry launch's `retryUpgrade`).
 */
export type LeadReviveView = { lead: TeamBot; open: TeamOwnedOpenTasks; availability: "ready" | "offline" | "upgrade" | "loading" };

export function leadReviveView(team: TeamState, machine: MachineLike): LeadReviveView | null {
  const lead = teamManagedLead(team);
  if (!lead || teamLeadReviveBlock(team, lead) !== null) return null;
  const open = teamOwnedOpenTasks(team, lead.id);
  // A daemon that runs team launches (teamLaunchVersion 1) runs this one: it is an ordinary lead launch.
  const availability = !machine || machine.metadata == null ? "loading"
    : (machine.metadata as { teamLaunchVersion?: unknown }).teamLaunchVersion !== 1 ? "upgrade"
    : !machine.active ? "offline" : "ready";
  return { lead, open, availability };
}

/** Whether `sessionId` is a past conversation of this team's stopped lead that the owner can bring back. */
export function leadSessionRevivable(team: TeamState, bot: TeamBot | undefined): boolean {
  return !!bot && bot.root && teamManagedLead(team)?.id === bot.id && teamLeadReviveBlock(team, bot) === null;
}

const en = {
  title: (n: number) => `The lead has stopped with ${n} ${n === 1 ? "task" : "tasks"} still open`,
  counts: (o: TeamOwnedOpenTasks) => `${o.submitted} to review · ${o.queued} queued · ${o.running} in progress`,
  hint: "Bring it back to relaunch the lead on the same computer and repository, in a fresh worktree, so it can review and continue these tasks.",
  button: "Bring the lead back",
  offline: "The team's computer is offline. Bring the lead back once it is online.",
  upgrade: "Update the CLI on this computer to bring the lead back from here.",
  loading: "Checking the team's computer…",
  openTasks: (n: number) => `The lead still has ${n} open ${n === 1 ? "task" : "tasks"}`,
  openTasksHint: "Have the lead accept, cancel or hand them off first. Accepting now would stop the lead and leave them with no one to handle them.",
  session: (team: string, n: number) => `This is a past conversation of the lead of “${team}”. The lead stopped after its goal was accepted and its working directory was cleaned up, while ${n} ${n === 1 ? "task" : "tasks"} it delegated are still open. Bring the lead back from the team page: it relaunches on the same computer and repository.`,
  sessionLink: "Open the team to bring it back",
  refusals: {
    lead_online: "The lead is already running.",
    lead_has_task: "The lead is already starting or has its own task.",
    lead_launch_pending: "The lead is already starting.",
    lead_has_no_open_tasks: "The lead has no open tasks left.",
    lead_cleanup_pending: "The lead's cleanup is not finished. Handle it under Execution needs attention first.",
    lead_not_managed: "This lead was not started by the team, so it cannot be relaunched here.",
  } as Record<string, string>,
};
const zh: typeof en = {
  title: (n) => `负责人已停止，还有 ${n} 个任务没收尾`,
  counts: (o) => `待验收 ${o.submitted} · 排队 ${o.queued} · 进行中 ${o.running}`,
  hint: "接回后，负责人会在原来的电脑和仓库里重新启动（新的工作目录），接着验收和推进这些任务。",
  button: "接回负责人",
  offline: "执行电脑离线，上线后才能接回负责人。",
  upgrade: "这台电脑的 CLI 更新后才能在这里接回负责人。",
  loading: "正在确认执行电脑…",
  openTasks: (n) => `负责人还有 ${n} 个任务没收尾`,
  openTasksHint: "先让负责人验收、取消或转交这些任务，再验收主任务。现在验收会停掉负责人，没人能再处理它们。",
  session: (team, n) => `这是团队「${team}」负责人以前的会话。主任务被验收后负责人已停止，工作目录也已清理，它派出的 ${n} 个任务还没收尾。在团队页接回负责人，会在原来的电脑和仓库里重新启动它。`,
  sessionLink: "去团队页接回负责人",
  refusals: {
    lead_online: "负责人已经在运行，不需要接回。",
    lead_has_task: "负责人已经在启动，或有自己的任务。",
    lead_launch_pending: "负责人已经在启动。",
    lead_has_no_open_tasks: "负责人名下已经没有没收尾的任务。",
    lead_cleanup_pending: "负责人的清理还没完成，先在「执行需要处理」里处理。",
    lead_not_managed: "这个负责人不是由团队启动的，不能在这里接回。",
  },
};
/** Both languages, for tests that every key has copy. */
export const LEAD_REVIVE_COPY = { en, zh };
export type LeadReviveCopy = typeof en;
export function leadReviveCopyFor(lang: string): LeadReviveCopy { return lang.startsWith("zh") ? zh : en; }
export function useLeadReviveCopy(): LeadReviveCopy { return leadReviveCopyFor(useTranslation().lang); }
