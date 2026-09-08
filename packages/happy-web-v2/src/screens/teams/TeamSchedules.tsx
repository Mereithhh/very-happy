import { useState } from "react";
import { Link } from "react-router-dom";
import type { TeamAction, TeamState } from "@slopus/happy-wire";
import { useTranslation } from "@/i18n/useTranslation";
import { scheduleAction } from "./scheduleDraft";

export function TeamSchedules({
  team,
  disabled,
  act,
}: {
  team: TeamState;
  disabled: boolean;
  act: (action: TeamAction) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState(false);
  const labels = {
    active: t("teams.scheduleActive"),
    paused: t("teams.schedulePaused"),
    cancelled: t("teams.cancelled"),
    completed: t("teams.scheduleCompleted"),
  };
  return (
    <section>
      <h2>{t("teams.schedules")}</h2>
      <p>{t("teams.scheduleBoundary")}</p>
      {(team.schedules ?? []).map((schedule) => {
        const bot = team.bots.find((b) => b.id === schedule.botId);
        return (
          <article className="teams-task" key={schedule.id}>
            <div className="teams-row">
              <strong>{schedule.name}</strong>
              <span>{labels[schedule.status]}</span>
            </div>
            <p>
              {bot?.sessionId ? (
                <Link to={`/session/${encodeURIComponent(bot.sessionId)}`}>
                  {bot.name}
                </Link>
              ) : (
                (bot?.name ?? schedule.botId)
              )}{" "}
              · {t("teams.nextRun")}：
              {schedule.nextRunAt === null
                ? "—"
                : new Date(schedule.nextRunAt).toLocaleString()}
            </p>
            <p>{schedule.body}</p>
            {schedule.pendingMessageId && <p>{t("teams.schedulePending")}</p>}
            <div className="teams-row">
              {schedule.status === "active" && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void act({
                      type: "schedule-pause",
                      scheduleId: schedule.id,
                      version: schedule.version,
                    })
                  }
                >
                  {t("teams.pauseSchedule")}
                </button>
              )}
              {schedule.status === "paused" && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void act({
                      type: "schedule-resume",
                      scheduleId: schedule.id,
                      version: schedule.version,
                    })
                  }
                >
                  {t("teams.resumeSchedule")}
                </button>
              )}
              {["active", "paused"].includes(schedule.status) && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void act({
                      type: "schedule-cancel",
                      scheduleId: schedule.id,
                      version: schedule.version,
                    })
                  }
                >
                  {t("teams.cancelSchedule")}
                </button>
              )}
            </div>
          </article>
        );
      })}
      {team.archivedAt === undefined && (
        <details>
          <summary>{t("teams.createSchedule")}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              const action = scheduleAction({
                name: String(f.get("name")),
                botId: String(f.get("botId")),
                body: String(f.get("body")),
                localTime: String(f.get("time")),
                intervalMinutes: String(f.get("interval")),
              });
              setError(!action);
              if (action) void act(action);
            }}
          >
            <label>
              {t("teams.scheduleName")}
              <input name="name" required maxLength={128} />
            </label>
            <label>
              {t("teams.scheduleRecipient")}
              <select name="botId" required>
                <option value="">{t("teams.chooseBot")}</option>
                {team.bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("teams.scheduleTime")}
              <input type="datetime-local" name="time" required />
            </label>
            <label>
              {t("teams.scheduleInterval")}
              <input
                type="number"
                name="interval"
                min={1}
                max={527040}
                step={1}
              />
            </label>
            <label className="teams-wide">
              {t("teams.scheduleBody")}
              <textarea name="body" required maxLength={32000} />
            </label>
            {error && (
              <p role="alert" className="teams-error">
                {t("teams.invalidSchedule")}
              </p>
            )}
            <button disabled={disabled || team.bots.length === 0}>
              {t("teams.createSchedule")}
            </button>
          </form>
        </details>
      )}
    </section>
  );
}
