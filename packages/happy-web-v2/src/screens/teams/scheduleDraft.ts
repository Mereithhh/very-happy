import type { TeamAction } from "@slopus/happy-wire";
export function scheduleAction(draft: {
  name: string;
  botId: string;
  body: string;
  localTime: string;
  intervalMinutes: string;
}): Extract<TeamAction, { type: "schedule-create" }> | null {
  const runAt = new Date(draft.localTime).getTime();
  const minutes = draft.intervalMinutes.trim()
    ? Number(draft.intervalMinutes)
    : undefined;
  if (
    !draft.name.trim() ||
    !draft.botId ||
    !draft.body.trim() ||
    !Number.isFinite(runAt) ||
    runAt <= 0 ||
    (minutes !== undefined &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > 527040))
  )
    return null;
  return {
    type: "schedule-create",
    name: draft.name.trim(),
    botId: draft.botId,
    body: draft.body.trim(),
    runAt,
    ...(minutes === undefined ? {} : { intervalMs: minutes * 60000 }),
  };
}
