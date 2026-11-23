/**
 * B-962: 「恢复团队」 — an archived team (exit from team mode included) comes back within 7 days:
 * the tasks, schedules and undelivered messages its archive cancelled, and each member in its own
 * conversation and worktree. The rules live in happy-wire (`archiveRestorable`, `teamRestoreBlock`)
 * and on the server; this file is the page's view of them.
 */
import { archiveRestorable, teamRestoreBlock, TEAM_RESTORE_WINDOW_MS, type TeamState } from "@slopus/happy-wire";
import { useTranslation } from "@/i18n/useTranslation";

type MachineLike = { metadata?: unknown; active?: boolean } | undefined;
export type TeamRestoreConflict = { botId: string; botName: string; root: boolean; sessionId: string; teamId: string; teamName: string };
export type TeamRestoreView = {
  tasks: number; schedules: number; messages: number;
  /** Days left (rounded up) before the team can no longer be restored. */
  daysLeft: number;
  source: "web" | "cli" | "unknown";
  availability: "ready" | "offline" | "upgrade" | "loading" | "expired";
};

/** The archived team page's restore state; null for a live team. */
export function teamRestoreView(team: TeamState, machine: MachineLike, now: number): TeamRestoreView | null {
  if (team.archivedAt === undefined) return null;
  const restorable = archiveRestorable(team)!;
  const left = team.archivedAt + TEAM_RESTORE_WINDOW_MS - now;
  const availability = teamRestoreBlock(team, now) ? "expired"
    : !machine || machine.metadata == null ? "loading"
    // Members continue their own sessions only on a daemon that runs restore launches.
    : (machine.metadata as { teamRestoreVersion?: unknown }).teamRestoreVersion !== 1 ? "upgrade"
    : !machine.active ? "offline" : "ready";
  return {
    tasks: restorable.tasks.length, schedules: restorable.schedules.length, messages: restorable.messageIds.length,
    daysLeft: Math.max(0, Math.ceil(left / 86_400_000)),
    source: team.archive?.at === team.archivedAt ? team.archive.source : "unknown",
    availability,
  };
}

/** The conflicts a `restore_conflict` refusal names (members whose conversation another live team holds). */
export function restoreConflicts(details: unknown): TeamRestoreConflict[] {
  const list = (details as { conflicts?: unknown } | null | undefined)?.conflicts;
  return Array.isArray(list) ? list.filter((c): c is TeamRestoreConflict => !!c && typeof c === "object" && typeof (c as TeamRestoreConflict).botId === "string") : [];
}

const en = {
  title: "This team is archived",
  counts: (v: TeamRestoreView) => `${v.tasks} ${v.tasks === 1 ? "task" : "tasks"} · ${v.schedules} ${v.schedules === 1 ? "schedule" : "schedules"} · ${v.messages} undelivered ${v.messages === 1 ? "message" : "messages"} were cancelled by the archive.`,
  source: { web: "Archived from the Web.", cli: "Archived from the command line.", unknown: "" } as Record<TeamRestoreView["source"], string>,
  hint: (days: number) => `Restore brings them back: each member continues its own conversation in its own working directory, and the lead rejoins the team. You can restore it for ${days} more ${days === 1 ? "day" : "days"}.`,
  button: "Restore team",
  confirmTitle: "Restore this team?",
  confirmBody: "Cancelled tasks, schedules and undelivered messages come back, and members restart in their own conversations. Tasks that were finished stay finished.",
  offline: "The team's computer is offline. Restore the team once it is online.",
  upgrade: "Update the CLI on the team's computer to restore this team (members need it to continue their own conversations).",
  loading: "Checking the team's computer…",
  expired: "This team was archived more than 7 days ago and can no longer be restored. Start a new team instead.",
  conflictTitle: "Some conversations are in another team now",
  conflictItem: (c: TeamRestoreConflict) => `${c.root ? "Lead" : c.botName}: its conversation is in “${c.teamName}”`,
  conflictHint: "Restore without them: each of these members starts a new session from the team's repository. Their original conversations stay in the other team, untouched.",
  conflictSkip: "Restore, start these members fresh",
  conflictCancel: "Cancel",
  restored: "Team restored. Members are continuing their conversations.",
  listTitle: "Recently archived",
  listHint: "Teams archived in the last 7 days. Open one to restore it.",
  archivedAt: (at: string) => `archived ${at}`,
  refusals: {
    restore_expired: "This team was archived more than 7 days ago and can no longer be restored.",
    restore_cleanup_pending: "Members are still stopping. Try again in a minute.",
    team_not_archived: "This team is not archived.",
    team_limit: "You have the maximum number of live teams. Archive another team first.",
  } as Record<string, string>,
};
const zh: typeof en = {
  title: "这个团队已归档",
  counts: (v) => `归档取消了 ${v.tasks} 个任务、${v.schedules} 个定时安排、${v.messages} 条未送达的消息。`,
  source: { web: "从网页归档。", cli: "从命令行归档。", unknown: "" },
  hint: (days) => `恢复后它们会回来：每个成员在自己原来的工作目录里接着原来的对话，负责人重新回到团队。还可以恢复 ${days} 天。`,
  button: "恢复团队",
  confirmTitle: "恢复这个团队？",
  confirmBody: "被取消的任务、定时安排和未送达的消息会恢复，成员在各自原来的对话里重新启动。已经完成的任务保持完成。",
  offline: "执行电脑离线，上线后才能恢复团队。",
  upgrade: "执行电脑的 CLI 更新后才能恢复团队（成员续上原来的对话需要新版本）。",
  loading: "正在确认执行电脑…",
  expired: "这个团队归档已超过 7 天，不能再恢复。请新建团队。",
  conflictTitle: "部分成员的原会话已在另一个团队里",
  conflictItem: (c) => `${c.root ? "负责人" : c.botName}：原会话在团队「${c.teamName}」里`,
  conflictHint: "可以跳过它们恢复：这些成员会在团队的原仓库里新起一个会话，原来的会话不动，继续留在另一个团队。",
  conflictSkip: "恢复，这些成员新起会话",
  conflictCancel: "取消",
  restored: "团队已恢复，成员正在接着原来的对话继续。",
  listTitle: "最近归档",
  listHint: "7 天内归档的团队，打开后可以恢复。",
  archivedAt: (at) => `归档于 ${at}`,
  refusals: {
    restore_expired: "这个团队归档已超过 7 天，不能再恢复。",
    restore_cleanup_pending: "成员还在停止中，请一分钟后再试。",
    team_not_archived: "这个团队没有归档。",
    team_limit: "进行中的团队已达上限，请先归档其他团队。",
  },
};
/** Both languages, for tests that every key has copy. */
export const TEAM_RESTORE_COPY = { en, zh };
export type TeamRestoreCopy = typeof en;
export function teamRestoreCopyFor(lang: string | undefined): TeamRestoreCopy { return lang?.startsWith("zh") ? zh : en; }
export function useTeamRestoreCopy(): TeamRestoreCopy { return teamRestoreCopyFor(useTranslation().lang); }
