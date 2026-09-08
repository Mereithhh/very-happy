import { useEffect, useState, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { TeamAction, TeamState } from "@slopus/happy-wire";
import {
  actOnTeam,
  createTeam,
  getTeam,
  listTeams,
  TeamsApiError,
} from "@/sync/teams";
import { useAllMachines } from "@/sync/storage";
import { isMachineOnline, machineLabel } from "@/utils/machineUtils";
import "./teams.css";
import { TeamSchedules } from "./TeamSchedules";
import { t as tr } from "@/text";
import { sync } from "@/sync/sync";
import {
  archiveBlocker,
  canReconcileOperation,
  newestTeam,
  taskRows,
} from "./teamView";
import { useTranslation } from "@/i18n/useTranslation";
const taskStatus = (): Record<string, string> => ({
  queued: tr("teams.queued"),
  running: tr("teams.running"),
  submitted: tr("teams.submitted"),
  done: tr("teams.done"),
  cancelled: tr("teams.cancelled"),
});
export function TeamsScreen() {
  const { teamId } = useParams();
  return <TeamsContent key={teamId ?? "list"} />;
}
function TeamsContent() {
  useTranslation();
  const { teamId } = useParams();
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const createRequest = useRef({ signature: "", id: "" });
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState<{
    action: TeamAction;
    requestId: string;
  } | null>(null);
  function fail(e: unknown) {
    if (e instanceof TeamsApiError && e.status === 404) setUnavailable(true);
    setError(
      e instanceof TeamsApiError && e.status === 404
        ? tr("teams.unavailable")
        : tr("teams.failed", {
            reason: e instanceof Error ? e.message : "network_error",
          }),
    );
  }
  async function load() {
    try {
      if (teamId) {
        const next = (await getTeam(teamId)).team;
        setTeam((previous) => newestTeam(previous, next));
      } else setTeams((await listTeams()).teams);
      setUnavailable(false);
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    setTeam(null);
    setError("");
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    const unsubscribe = sync.onResume(() => {
      void load();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [teamId]);
  async function act(action?: TeamAction) {
    if (!teamId || busy) return;
    const p =
      pending ?? (action ? { action, requestId: crypto.randomUUID() } : null);
    if (!p) return;
    setPending(p);
    setBusy(true);
    try {
      const next = (await actOnTeam(teamId, p.action, p.requestId)).team;
      setTeam((previous) => newestTeam(previous, next));
      setPending(null);
      setError("");
    } catch (e) {
      if (e instanceof TeamsApiError && e.status < 500) {
        setPending(null);
        if (e.status === 409) void load();
      }
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const disabled =
    busy || pending !== null || unavailable || team?.archivedAt !== undefined;
  const supportsTeams = (machine: (typeof machines)[number]) =>
    (machine.metadata as { teamsVersion?: number } | null)?.teamsVersion ===
      1 && isMachineOnline(machine);
  const dispatchReady =
    !!team &&
    machines.some(
      (machine) => machine.id === team.machineId && supportsTeams(machine),
    );
  return (
    <main className="teams-screen">
      <header>
        <Link to="/">{tr("teams.sessions")}</Link> /{" "}
        <Link to="/teams">{tr("teams.teams")}</Link>
        <h1>{team?.name ?? "Agent teams"}</h1>
        {team?.archivedAt !== undefined && (
          <p role="status">
            {tr("teams.archived")} ·{" "}
            {new Date(team.archivedAt).toLocaleString()}
          </p>
        )}
        <button
          onClick={() => {
            setError("");
            void load();
          }}
        >
          {tr("teams.refresh")}
        </button>
      </header>
      {error && (
        <p role="alert" className="teams-error">
          {error}
          {pending && (
            <button disabled={busy} onClick={() => void act()}>
              {tr("teams.retry")}
            </button>
          )}
        </p>
      )}
      {!teamId && (
        <>
          <p>{tr("teams.intro")}</p>
          {!machines.some(supportsTeams) && (
            <p role="status">{tr("teams.machineRequired")}</p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              try {
                const name = String(f.get("name"));
                const machineId = String(f.get("machineId"));
                const signature = JSON.stringify([name, machineId]);
                if (createRequest.current.signature !== signature)
                  createRequest.current = {
                    signature,
                    id: crypto.randomUUID(),
                  };
                const r = await createTeam(
                  name,
                  machineId,
                  createRequest.current.id,
                );
                navigate(`/teams/${r.team.id}`);
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {tr("teams.name")}
              <input name="name" required maxLength={128} />
            </label>
            <label>
              {tr("teams.machine")}
              <select name="machineId" required>
                <option value="">{tr("teams.selectMachine")}</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id} disabled={!supportsTeams(m)}>
                    {machineLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="teams-primary"
              disabled={disabled || !machines.some(supportsTeams)}
            >
              {tr("teams.create")}
            </button>
          </form>
          {teams.map((item) => (
            <Link className="teams-row" key={item.id} to={`/teams/${item.id}`}>
              {item.name}
              <span>
                {tr("teams.counts", {
                  bots: item.bots.length,
                  tasks: item.tasks.length,
                })}
              </span>
            </Link>
          ))}
        </>
      )}
      {team && (
        <>
          <section>
            <h2>{tr("teams.bots")}</h2>

            {team.bots.map((b) => (
              <div className="teams-row" key={b.id}>
                <strong>{b.name}</strong>
                <span>{b.root ? tr("teams.lead") : b.assistant}</span>
                {b.lastEvent && (
                  <span>
                    {tr(`teams.${b.lastEvent}`)}{" "}
                    {b.lastEventAt
                      ? new Date(b.lastEventAt).toLocaleString()
                      : ""}
                  </span>
                )}
                {b.sessionId ? (
                  <Link to={`/session/${encodeURIComponent(b.sessionId)}`}>
                    {tr("teams.openSession")}
                  </Link>
                ) : (
                  <span>{tr("teams.starting")}</span>
                )}
              </div>
            ))}
            <details>
              <summary>{tr("teams.join")}</summary>
              <p>{tr("teams.joinHint")}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act({
                    type: "join",
                    name: String(f.get("name")),
                    sessionId: String(f.get("sessionId")),
                    botId: String(f.get("botId")) || undefined,
                  });
                }}
              >
                <label>
                  {tr("teams.leadName")}
                  <input name="name" required />
                </label>
                <label>
                  {tr("teams.sessionId")}
                  <input name="sessionId" required />
                </label>
                <label>
                  {tr("teams.rebind")}
                  <select name="botId">
                    <option value="">{tr("teams.newBot")}</option>
                    {team.bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={disabled}>{tr("teams.join")}</button>
              </form>
            </details>
          </section>
          <section>
            <details>
              <summary>{tr("teams.delegateTitle")}</summary>
              {!dispatchReady && (
                <p role="status">{tr("teams.machineRequired")}</p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act({
                    type: "delegate",
                    goal: String(f.get("goal")),
                    acceptance: String(f.get("acceptance"))
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    directory: String(f.get("directory")),
                    assistant: String(f.get("assistant")) as
                      | "claude"
                      | "codex"
                      | "pi-acp",
                    parentTaskId: String(f.get("parent")) || undefined,
                  });
                }}
              >
                <label className="teams-wide">
                  {tr("teams.goal")}
                  <textarea name="goal" required />
                </label>
                <label className="teams-wide">
                  {tr("teams.acceptance")}
                  <textarea name="acceptance" required />
                </label>
                <label>
                  {tr("teams.directory")}
                  <input
                    name="directory"
                    required
                    placeholder="/path/to/project"
                  />
                </label>
                <label>
                  Coding agent
                  <select name="assistant">
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                    <option value="pi-acp">pi</option>
                  </select>
                </label>
                <label>
                  {tr("teams.parent")}
                  <select name="parent">
                    <option value="">{tr("teams.independent")}</option>
                    {team.tasks
                      .filter((t) => !["done", "cancelled"].includes(t.status))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.goal}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="teams-primary"
                  disabled={disabled || !dispatchReady}
                >
                  {tr("teams.delegate")}
                </button>
              </form>
            </details>
          </section>
          <section>
            <h2>{tr("teams.tasks")}</h2>
            {taskRows(team.tasks).map(({ task: t, depth }) => (
              <article
                className="teams-task"
                style={{ paddingInlineStart: Math.min(depth, 3) * 12 }}
                key={t.id}
              >
                <div className="teams-row">
                  <strong>{t.goal}</strong>
                  <span data-live={t.status === "running"}>
                    {taskStatus()[t.status]}
                  </span>
                </div>
                {t.parentTaskId && (
                  <p>
                    {tr("teams.parent")}：
                    {team.tasks.find((p) => p.id === t.parentTaskId)?.goal ??
                      t.parentTaskId}
                  </p>
                )}
                <p>
                  {tr("teams.assignee")}：
                  {team.bots.find((b) => b.id === t.assigneeBotId)?.name ??
                    t.assigneeBotId}{" "}
                  · {tr("teams.cleanup")}：{t.cleanup}
                </p>
                <ul>
                  {t.acceptance.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
                {t.attempts.find((a) => a.id === t.currentAttemptId)
                  ?.result && (
                  <details>
                    <summary>{tr("teams.result")}</summary>
                    <pre>
                      {
                        t.attempts.find((a) => a.id === t.currentAttemptId)
                          ?.result
                      }
                    </pre>
                  </details>
                )}
                {t.status === "submitted" && (
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void act({
                        type: "accept",
                        taskId: t.id,
                        attemptId: t.currentAttemptId,
                        goalVersion: t.goalVersion,
                      })
                    }
                  >
                    {tr("teams.accept")}
                  </button>
                )}
                {!["done", "cancelled"].includes(t.status) && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      const type = String(f.get("action"));
                      const body = String(f.get("body"));
                      void act(
                        type === "message"
                          ? { type, taskId: t.id, body }
                          : {
                              type: type as "return" | "cancel",
                              taskId: t.id,
                              reason: body,
                              attemptId: t.currentAttemptId,
                              goalVersion: t.goalVersion,
                            },
                      );
                    }}
                  >
                    <label className="teams-wide">
                      {tr("teams.body")}
                      <textarea name="body" required />
                    </label>
                    <label>
                      {tr("teams.action")}
                      <select name="action">
                        <option value="message">{tr("teams.message")}</option>
                        {t.status === "submitted" && (
                          <option value="return">{tr("teams.return")}</option>
                        )}
                        <option value="cancel">{tr("teams.cancel")}</option>
                      </select>
                    </label>
                    <button disabled={disabled}>{tr("teams.execute")}</button>
                  </form>
                )}
                {!["done", "cancelled"].includes(t.status) &&
                  team.bots.length > 1 && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = new FormData(e.currentTarget);
                        void act({
                          type: "handoff",
                          taskId: t.id,
                          assigneeBotId: String(form.get("assignee")),
                          attemptId: t.currentAttemptId,
                          goalVersion: t.goalVersion,
                        });
                      }}
                    >
                      <label>
                        {tr("teams.transferTo")}
                        <select name="assignee" required>
                          {team.bots
                            .filter((bot) => bot.id !== t.assigneeBotId)
                            .map((bot) => (
                              <option key={bot.id} value={bot.id}>
                                {bot.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button disabled={disabled}>{tr("teams.handoff")}</button>
                    </form>
                  )}
                {team.messages
                  .filter((m) => m.taskId === t.id)
                  .slice(-5)
                  .map((m) => (
                    <p key={m.id}>
                      {m.body}{" "}
                      <small>
                        {m.deliveredAt
                          ? tr("teams.delivered")
                          : tr("teams.waitingDelivery")}
                      </small>
                    </p>
                  ))}
              </article>
            ))}
          </section>
          <TeamSchedules team={team} disabled={disabled} act={act} />
          <section>
            <h2>{tr("teams.operations")}</h2>
            {team.operations
              .filter(
                (operation) =>
                  ["failed", "unknown", "claimed"].includes(operation.status) ||
                  operation.manualResolution,
              )
              .map((operation) => (
                <OperationResolution
                  key={`${operation.id}:${operation.claimId ?? "unclaimed"}`}
                  team={team}
                  operation={operation}
                  disabled={disabled}
                  act={act}
                />
              ))}
          </section>
          {team.archivedAt === undefined && (
            <section>
              <h2>{tr("teams.archive")}</h2>
              <p>{tr("teams.archiveDescription")}</p>
              {archiveBlocker(team) && (
                <p role="status">{tr(`teams.${archiveBlocker(team)!}`)}</p>
              )}
              <button
                disabled={disabled || archiveBlocker(team) !== null}
                onClick={() => void act({ type: "archive" })}
              >
                {tr("teams.archive")}
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function OperationResolution({
  team,
  operation,
  disabled,
  act,
}: {
  team: TeamState;
  operation: TeamState["operations"][number];
  disabled: boolean;
  act: (action: TeamAction) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const eligible = canReconcileOperation(team, operation);
  return (
    <article className="teams-task">
      <p>
        {operation.type} · {operation.status} ·{" "}
        {operation.sessionId ? (
          <Link to={`/session/${encodeURIComponent(operation.sessionId)}`}>
            {tr("teams.openSession")}
          </Link>
        ) : (
          operation.id
        )}
      </p>
      {operation.manualResolution ? (
        <p>
          {tr("teams.reconciled")} ·{" "}
          {new Date(operation.manualResolution.at).toLocaleString()}
          <br />
          {operation.manualResolution.note}
        </p>
      ) : (
        <>
          <p
            className={
              ["failed", "unknown"].includes(operation.status)
                ? "teams-error"
                : undefined
            }
          >
            {operation.error ?? tr("teams.operationPending")}
          </p>
          {eligible ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmed && note.trim() && operation.claimId)
                  void act({
                    type: "reconcile-operation",
                    operationId: operation.id,
                    claimId: operation.claimId,
                    note: note.trim(),
                  });
              }}
            >
              <label className="teams-wide teams-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                />
                {tr("teams.reconcileConfirmation")}
              </label>
              <label className="teams-wide">
                {tr("teams.reconcileNote")}
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required
                  maxLength={32000}
                />
              </label>
              <button disabled={disabled || !confirmed || !note.trim()}>
                {tr("teams.reconcile")}
              </button>
            </form>
          ) : (
            <p>
              {operation.error === "task_closed_before_spawn"
                ? tr("teams.closedBeforeSpawn")
                : tr("teams.reconcileBlocked")}
            </p>
          )}
        </>
      )}
    </article>
  );
}
