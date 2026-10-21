import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { TeamAction, TeamState } from "@slopus/happy-wire";
import {
  actOnTeam,
  createTeam,
  getTeam,
  listTeams,
  TeamsApiError,
} from "@/sync/teams";
import { storage, useAllMachines } from "@/sync/storage";
import { useShallow } from "zustand/react/shallow";
import { botHistorySessionId } from "@/screens/sessions/teamNavigation";
import { isMachineOnline, machineLabel } from "@/utils/machineUtils";
import "./teams.css";
import { TeamSchedules } from "./TeamSchedules";
import { t as tr } from "@/text";
import { Bot, UsersRound, ArrowLeft, Settings2, Clock3, LayoutDashboard, Plus, RefreshCw, Archive, Check } from "lucide-react";
import { Markdown } from "@/screens/session/Markdown";
import { TeamWorkspace, TeamListCard } from "./TeamWorkspace";
import { refreshTeamNavigation } from "@/screens/sessions/useTeamNavigation";
import { teamLaunchPhase } from "./teamPresentation";
import { AdoptTeamForm } from "./AdoptTeamForm";
import { TeamStartForm } from "./TeamStartForm";
import { useFirstUseCopy } from "./firstUseCopy";
import { TeamOptions } from "./TeamOptions";
import { TeamDialog } from "./TeamDialog";
import { TeamTaskMessages, TeamTaskSummary } from "./TeamTaskDetail";
import { useWorkspaceCopy } from "./workspaceCopy";
import { sync } from "@/sync/sync";
import {
  canReconcileOperation,
  attentionOperations,
  canRetryCleanup,
  canRetryLaunch,
  machineSupportsTeamRetry,
  newestTeam,
} from "./teamView";
import { useTranslation } from "@/i18n/useTranslation";
export function TeamsScreen() {
  const { teamId } = useParams();
  return <TeamsContent key={teamId ?? "list"} />;
}
function TeamsContent() {
  const { t } = useTranslation();
  const c = useWorkspaceCopy();
  const first = useFirstUseCopy();
  const [archiving, setArchiving] = useState(false);
  const [startingExisting, setStartingExisting] = useState(false);
  const [view, setView] = useState<"overview" | "schedules" | "settings">("overview");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const { teamId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("new") === "1") setCreating(true);
    const task = searchParams.get("task");
    if (task) setSelectedTask(task);
  }, [searchParams]);
  // B-713: the sidebar's 新建团队 opens this dialog via ?new=1; closing drops
  // the param so the next click (same URL) opens it again.
  function closeCreate() {
    setCreating(false);
    if (searchParams.has("new")) {
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }
  const machines = useAllMachines({ includeOffline: true });
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [followLead, setFollowLead] = useState(searchParams.get("starting") === "1");
  const [pending, setPending] = useState<{
    action: TeamAction;
    requestId: string;
  } | null>(null);
  function fail(e: unknown) {
    if (e instanceof TeamsApiError && [403, 404].includes(e.status)) setUnavailable(true);
    setError(
      e instanceof TeamsApiError && [403, 404].includes(e.status)
        ? first.unavailable
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
    } finally { setLoading(false); }
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
      void refreshTeamNavigation();
      setPending(null);
      setError("");
      if (p.action.type === "delegate") setDelegating(false);
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
  useEffect(() => {
    const lead = team?.bots.find(bot => bot.root && bot.sessionId);
    if (followLead && lead?.sessionId) navigate(`/session/${encodeURIComponent(lead.sessionId)}`);
  }, [team, followLead, navigate]);
  const disabled =
    busy || pending !== null || unavailable || team?.archivedAt !== undefined;
  const supportsTeams = (machine: (typeof machines)[number]) =>
    (machine.metadata as { teamLaunchVersion?: number } | null)?.teamLaunchVersion ===
      1 && isMachineOnline(machine);
  const launchPhase = team ? teamLaunchPhase(team) : "empty";
  // B-690: member conversations that are archived (or gone from the account's
  // list) — one input of the shared 「已停用」 rule. Nothing counts until the
  // session list has loaded.
  const archivedMemberKey = storage(useShallow((state) => !state.isDataReady || !team ? [] : team.bots.flatMap((bot) => {
    const sessionId = botHistorySessionId(team, bot);
    const session = sessionId ? state.sessions[sessionId] : undefined;
    return sessionId && (!session || session.archivedAt != null) ? [sessionId] : [];
  }))).join("\n");
  const archivedMemberSessions = useMemo(() => new Set(archivedMemberKey ? archivedMemberKey.split("\n") : []), [archivedMemberKey]);
  const attention = team ? attentionOperations(team) : { open: [], resolved: [] };
  const executionMachine = machines.find(machine => machine.id === team?.machineId);
  const machineOnline = !!executionMachine && isMachineOnline(executionMachine);
  const dispatchReady =
    !!team &&
    machines.some(
      (machine) => machine.id === team.machineId && supportsTeams(machine),
    );
  return (
    <main className="teams-screen">
      <header className="teams-heading">
        <div><Link className="teams-back" to={teamId ? "/teams" : "/"}><ArrowLeft size={16} />{teamId ? c.title : tr("teams.sessions")}</Link>
          <h1><UsersRound size={26} aria-hidden />{team?.name ?? c.title}</h1>
          <p>{team ? <><span data-live={machineOnline}>{machineOnline ? c.online : c.offline}</span> · {executionMachine ? machineLabel(executionMachine) : c.unnamedMachine}</> : c.intro}</p>
          {team?.archivedAt !== undefined && <p role="status">{tr("teams.archived")} · {new Date(team.archivedAt).toLocaleString()}</p>}
        </div>
        <div className="teams-heading-actions">
          <Link to="/help">{c.guide}</Link>
          {team && team.archivedAt === undefined && <button disabled={disabled} onClick={() => setArchiving(true)}><Archive size={16}/>{tr('teams.archive')}</button>}
          {teamId ? <button aria-label={tr("teams.refresh")} title={tr("teams.refresh")} onClick={() => { setError(""); void load(); }}><RefreshCw size={17} /></button> : <button className="teams-primary" disabled={unavailable} onClick={() => setCreating(true)}><Plus size={16} />{c.create}</button>}
        </div>
      </header>
      {archiving && team && <TeamDialog title={tr('teams.archive')} onClose={() => setArchiving(false)}>
        <p>{tr('teams.archiveDescription')}</p>
        <button disabled={disabled} onClick={async () => { await act({type:'archive'}); setArchiving(false); }}>{tr('teams.archive')}</button>
      </TeamDialog>}
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
      {searchParams.get('fromSession') && <TeamDialog title={first.title} onClose={() => { const next = new URLSearchParams(searchParams); next.delete('fromSession'); setSearchParams(next, {replace:true}); }}><AdoptTeamForm sessionId={searchParams.get('fromSession')!} onDone={() => navigate(`/session/${encodeURIComponent(searchParams.get('fromSession')!)}`)} /></TeamDialog>}
      {loading && <p role="status">{tr("common.loading")}</p>}
      {!teamId && !loading && (
        <>

          {!machines.some(supportsTeams) && (
            <p role="status">{tr("teams.machineRequired")}</p>
          )}
          {creating && <TeamDialog title={c.create} onClose={closeCreate}>
            {error && <p role="alert" className="teams-error">{error}</p>}
          <TeamStartForm onStart={async (name, machineId, launch, requestId) => {
            return (await createTeam(name, machineId, requestId, launch)).team;
          }} onStarted={created => {
            void refreshTeamNavigation();
            navigate(`/teams/${created.id}?starting=1`);
          }} />
          </TeamDialog>}
          {!teams.length && !unavailable && <div className="teams-empty"><UsersRound size={36} aria-hidden /><h2>{c.noTeams}</h2><p>{c.noTeamsHint}</p><Link to="/help">{c.guide} →</Link></div>}
          <div className="teams-list">{teams.map(item => <TeamListCard key={item.id} team={item} machine={machines.find(m => m.id === item.machineId) ? machineLabel(machines.find(m => m.id === item.machineId)!) : c.unnamedMachine} />)}</div>
        </>
      )}
      {team && (
        <>
          <nav className="teams-tabs" aria-label={c.title}>
            {([{id: "overview", label: c.overview, Icon: LayoutDashboard}, {id: "schedules", label: c.schedules, Icon: Clock3}, {id: "settings", label: c.settings, Icon: Settings2}] as const).map(({id, label, Icon}) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}><Icon size={16} />{label}</button>)}
          </nav>
          {view === "overview" && <>
            {!dispatchReady && <p role="status">{tr("teams.machineRequired")}</p>}
            {team.bots.length === 0 && <div className="teams-empty"><h2>{first.setup}</h2><p>{first.setupHint}</p><button className="teams-primary" disabled={disabled} onClick={() => setStartingExisting(true)}>{first.start}</button></div>}
            {['preparing', 'failed'].includes(launchPhase) && <div className="team-launch-state" role="status"><h2>{launchPhase === 'failed' ? first.failed : first.preparing}</h2><p>{launchPhase === 'failed' ? first.failedHint : first.preparingHint}</p>{team.tasks.filter(task => team.bots.some(bot => bot.root && bot.id === task.assigneeBotId)).map(task => <button key={task.id} onClick={() => setSelectedTask(task.id)}>{first.inspect}</button>)}</div>}
            <div className="teams-work-actions">
              {team.bots.find(b => b.root && b.sessionId)?.sessionId && <Link className="teams-primary teams-talk" to={`/session/${encodeURIComponent(team.bots.find(b => b.root && b.sessionId)!.sessionId!)}`}><Bot size={18} />{c.talk}</Link>}
              <button disabled={disabled || !dispatchReady} onClick={() => setDelegating(true)}><Plus size={16} />{c.newTask}</button>
            </div>
            <TeamWorkspace team={team} onTask={setSelectedTask} archivedSessionIds={archivedMemberSessions} />
          </>}
          {view === "settings" && <>          <section>
            <label>{tr("teams.executionMode")}
              <select disabled={disabled} value={team.permissionMode ?? "default"}
                onChange={(event) => void act({ type: "set-permission-mode", permissionMode: event.target.value === "bypassPermissions" ? "bypassPermissions" : "default" })}>
                <option value="default">{tr("teams.approvalDefault")}</option>
                <option value="bypassPermissions">{tr("teams.approvalBypass")}</option>
              </select>
            </label>
            <p>{tr("teams.executionModeHint")}</p>
          </section>
            <TeamOptions team={team} disabled={disabled} onSave={async defaults => { await act({type: 'set-defaults', defaults}); }} />
          </>}
          {startingExisting && <TeamDialog title={first.setup} onClose={() => setStartingExisting(false)}><TeamStartForm machineId={team.machineId} intentScope={`team:${team.id}`} onStart={async (_name, _machineId, launch, requestId) => {
            return (await actOnTeam(team.id, {type: 'start', launch}, requestId)).team;
          }} onStarted={started => {
            void refreshTeamNavigation();
            setTeam(started); setStartingExisting(false); setFollowLead(true);
          }} /></TeamDialog>}
          {delegating && <TeamDialog title={c.newTask} onClose={() => setDelegating(false)}>
            {error && <p role="alert" className="teams-error">{error}</p>}{pending && <button disabled={busy} onClick={() => void act()}>{tr("teams.retry")}</button>}
              {!dispatchReady && (
                <p role="status">{tr("teams.machineRequired")}</p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act({
                    type: "delegate",
                    botName: String(f.get("botName") ?? "").trim() || undefined,
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
                    defaultValue={team.creationLaunch?.directory ?? team.bots.find(b => b.root)?.directory ?? ""}
                    placeholder="/path/to/project"
                  />
                </label>
                <label>{first.member}<input name="botName" placeholder={first.working} maxLength={128} /></label>
                <label>
                  {t('teams.codingAgent')}
                  <select name="assistant" defaultValue={team.defaults?.assistant ?? "claude"}>
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
          </TeamDialog>}
          {team.tasks.filter(task => task.id === selectedTask).map((t) => (
            <TeamDialog key={t.id} title={c.details} onClose={() => { setSelectedTask(null); if (searchParams.has("task")) { const next = new URLSearchParams(searchParams); next.delete("task"); setSearchParams(next, {replace:true}); } requestAnimationFrame(() => document.getElementById(`team-task-${t.id}`)?.focus()); }}>
              {error && <p role="alert" className="teams-error">{error}</p>}{pending && <button disabled={busy} onClick={() => void act()}>{tr("teams.retry")}</button>}
              <article
                className="teams-task"
                key={t.id}
              >
<TeamTaskSummary team={team} task={t} launchIssue={(issue) => <LaunchIssue team={team} operation={issue} retrySupported={machineSupportsTeamRetry(executionMachine?.metadata)} disabled={disabled} act={act} />} />
                {t.attempts.find((a) => a.id === t.currentAttemptId)
                  ?.result && (
                  <div className="teams-full-result">
                    <h3>{tr("teams.result")}</h3>
                    <Markdown text={t.attempts.find(a => a.id === t.currentAttemptId)?.result ?? ""} />
                  </div>
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
                <TeamTaskMessages team={team} task={t} />
              </article>
            </TeamDialog>
          ))}
          {view === "schedules" && <TeamSchedules team={team} disabled={disabled} act={act} />}
          {(attention.open.length > 0 || attention.resolved.length > 0) && <section>
            {attention.open.length > 0 && <h2>{c.attention}</h2>}
            {attention.open.map((operation) => (
                <OperationResolution
                  key={`${operation.id}:${operation.claimId ?? "unclaimed"}`}
                  team={team}
                  operation={operation}
                  retrySupported={machineSupportsTeamRetry(executionMachine?.metadata)}
                  cleanupRetrySupported={machineSupportsTeamRetry(executionMachine?.metadata, 2)}
                  disabled={busy || pending !== null || unavailable}
                  act={act}
                />
              ))}
            {/* B-691: handled entries stay readable but stop crowding the page. */}
            {attention.resolved.length > 0 && <details className="teams-resolved">
              <summary>{c.resolvedCount(attention.resolved.length)}</summary>
              {attention.resolved.map((operation) => (
                <OperationResolution
                  key={`${operation.id}:${operation.claimId ?? "unclaimed"}`}
                  team={team}
                  operation={operation}
                  retrySupported={false}
                  cleanupRetrySupported={false}
                  disabled
                  act={act}
                />
              ))}
            </details>}
          </section>}
          {view === "settings" && team.archivedAt === undefined && (
            <section>
              <h2>{tr("teams.archive")}</h2>
              <p>{tr("teams.archiveDescription")}</p>
              <button
                disabled={disabled}
                onClick={() => setArchiving(true)}
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

/** B-689: why a launch is stuck, what the computer does next, and the owner's retry. */
function LaunchIssue({
  team,
  operation,
  retrySupported,
  disabled,
  act,
}: {
  team: TeamState;
  operation: TeamState["operations"][number];
  retrySupported: boolean;
  disabled: boolean;
  act: (action: TeamAction) => Promise<void>;
}) {
  const first = useFirstUseCopy();
  const [confirmed, setConfirmed] = useState(false);
  const uncertain = operation.status === "unknown";
  const retryable = canRetryLaunch(team, operation) && !!operation.claimId;
  return (
    <div className="teams-error" role="alert">
      <strong>{first.launchFailed}</strong>
      <p>{operation.error}</p>
      <p>{uncertain ? first.unknownHint : first.retryHint}</p>
      {retryable && !retrySupported && <p>{first.retryUpgrade}</p>}
      {retryable && retrySupported && (
        <form
          className="teams-launch-retry"
          onSubmit={(event) => {
            event.preventDefault();
            if ((!uncertain || confirmed) && operation.claimId)
              void act({ type: "retry-operation", operationId: operation.id, claimId: operation.claimId });
          }}
        >
          {uncertain && (
            <label className="teams-confirm">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required />
              {first.retryConfirm}
            </label>
          )}
          <button disabled={disabled || (uncertain && !confirmed)}>
            <RefreshCw size={16} aria-hidden />
            {first.retryLaunch}
          </button>
          {operation.retryRequestedAt !== undefined && (
            <small role="status">{first.retryRequested} · {new Date(operation.retryRequestedAt).toLocaleString()}</small>
          )}
        </form>
      )}
    </div>
  );
}

function OperationResolution({
  team,
  operation,
  retrySupported,
  cleanupRetrySupported,
  disabled,
  act,
}: {
  team: TeamState;
  operation: TeamState["operations"][number];
  retrySupported: boolean;
  cleanupRetrySupported: boolean;
  disabled: boolean;
  act: (action: TeamAction) => Promise<void>;
}) {
  const c = useWorkspaceCopy();
  const first = useFirstUseCopy();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const eligible = canReconcileOperation(team, operation);
  const cleanupRetry = canRetryCleanup(operation);
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
            <>
            {operation.type === "stop" && operation.status === "failed" && <p>{c.cleanupHint}</p>}
            {cleanupRetry && !cleanupRetrySupported && <p>{c.cleanupUpgrade}</p>}
            {/* B-691: the two ways out of a retained cleanup, side by side. */}
            <div className="teams-op-actions">
              {cleanupRetry && cleanupRetrySupported && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { if (operation.claimId) void act({ type: "retry-operation", operationId: operation.id, claimId: operation.claimId }); }}
                >
                  <RefreshCw size={16} aria-hidden />
                  {c.retryCleanup}
                </button>
              )}
              {!reconciling && (
                <button type="button" disabled={disabled} onClick={() => setReconciling(true)}>
                  <Check size={16} aria-hidden />
                  {c.markHandled}
                </button>
              )}
              {operation.retryRequestedAt !== undefined && (
                <small role="status">{first.retryRequested} · {new Date(operation.retryRequestedAt).toLocaleString()}</small>
              )}
            </div>
            {reconciling && <form
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
            </form>}
            </>
          ) : canRetryLaunch(team, operation) ? (
            <LaunchIssue team={team} operation={operation} retrySupported={retrySupported} disabled={disabled} act={act} />
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

