import { ProjectPicker } from '@/screens/projects/ProjectPicker';
import { isHarnessInstallId, type HarnessInstallId } from '@slopus/happy-wire';
import { harnessInstallSupported } from '@/app/harnessInstall';
import { readAgentVersions } from '@/app/agentVersions';
import { useHarnessInstall } from '@/app/useHarnessInstall';
import { useProjects } from '@/sync/projects';
import { suggestProjectFor } from '@/screens/projects/projectSuggestion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bookmark, Check, X } from 'lucide-react';
import { useAllMachines, useLocalSetting, useSetting, useSettingMutable } from '@/sync/storage';
import { isMachineOnline, pickDefaultMachineId } from '@/utils/machineUtils';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import type { RecentMachinePath } from '@/utils/quickChat';
import { newSessionTimingStart } from '@/app/newSessionTiming';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { pendingSessions } from '@/sync/pendingSessionsRuntime';
import { Button, Combobox, Spinner } from '@/ui';
import type { SelectOption } from '@/ui';
import { toast } from '@/ui/Toast';
import { useTranslation } from '@/i18n/useTranslation';
import { ConnectMachineLink, NoMachinesNotice } from './NoMachinesNotice';
import { claudeAuthNotice, hasClaudeAuthNotice } from './claudeAuthNotice';
import { useImeGuard } from '@/utils/ime';
import { Command } from '@/screens/onboarding/ConnectMachineGuide';
import {
  agentSetupInstruction,
  agentsNeedingSetup,
  isAgentOffered,
  resolveAgentAvailability,
  SESSION_AGENTS,
  type SessionAgent,
} from '@/utils/agentAvailability';
import { EMPTY_WORKTREE_DRAFT, NewWorktreeFields, useWorktreeInfo, worktreeDraftReady, type WorktreeDraft } from './NewWorktreeFields';
import { worktreeCreate } from '@/sync/worktreeOps';
import { machineSupportsWorktrees } from '@/utils/worktree';
import { worktreeCopy, worktreeErrorText } from './worktreeCopy';
import './newsession.css';

interface PathPreset {
  id: string;
  path: string;
  label?: string;
}

function machineLabel(m: any): string {
  return m?.metadata?.displayName || m?.metadata?.host || m?.id?.slice(0, 8) || 'machine';
}
function newId(): string {
  const c = (globalThis as any).crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
}

export function NewSessionModal({
  onClose,
  initialCommandDefault,
  initialLocation,
  spawnedTaskId,
}: {
  onClose: () => void;
  initialLocation?: RecentMachinePath;
  /** Prefill for the initial-instruction field (Task Board dispatch passes
   *  the task description so it becomes the session's first message). */
  initialCommandDefault?: string;
  /** Task Board dispatch: the pending-session store attaches the new session
   *  to this task once the spawn succeeds (B-516 — it may land after this
   *  dialog and even the board are gone). */
  spawnedTaskId?: string;
}) {
  const navigate = useNavigate();
  const { t, lang } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const [presets, setPresets] = useSettingMutable('sessionPathPresets');
  const list = (presets as PathPreset[] | undefined) ?? [];

  const defaultAgent = useSetting('newSessionAgent');
  const agentDefaultOverrides = useSetting('agentDefaultOverrides');
  const reviewFirst = useLocalSetting('newSessionReviewFirst');

  const [machineId, setMachineId] = useState(initialLocation?.machineId ?? '');
  const [directory, setDirectory] = useState(initialLocation?.path ?? list[0]?.path ?? '');
  const [editingId, setEditingId] = useState<string | null>(initialLocation ? null : list[0]?.id ?? null);
  const [agent, setAgent] = useState<SessionAgent>(() => normalizeAgentKey(defaultAgent));
  // B-596: the not-installed agent whose install command is shown (its greyed button was selected).
  const [setupAgent, setSetupAgent] = useState<Exclude<SessionAgent, 'claude'> | null>(null);
  const [initialCommand, setInitialCommand] = useState(initialCommandDefault ?? '');
  // B-649: project picker. Until the user picks, it follows the folder: a path
  // inside a project folder pre-selects that project (visible, one click to
  // change to 无项目) — the dialog is an explicit choice, not a silent join.
  const projectsSnap = useProjects();
  const [pickedProject, setPickedProject] = useState<string | null | undefined>(undefined);
  const liveProjects = projectsSnap.projects.filter((p) => !p.archivedAt);
  const ime = useImeGuard();

  // ── B-147: nothing derived from the stores may live in a useState initializer.
  // `useAllMachines` answers [] until the store is hydrated (storage.ts's
  // `!isDataReady` guard) and settings can be overwritten by a later server
  // sync, so every initializer below used to freeze at a pre-hydration value:
  // machineId at '' (→ the picker matches no option, `canCreate` false FOREVER,
  // Create permanently disabled on a cold start — the exact bug B-146 fixed in
  // the terminal dialog), and directory/agent at "no presets / default agent"
  // even after the real values arrived.
  //
  // Machine: re-derive on every change of the online set. Passing `machineId` as
  // preferred makes it idempotent once a live machine is selected (no setState
  // loop) and re-picks when the chosen machine drops off.
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    if (initialLocation && machineId === initialLocation.machineId) return;
    const next = pickDefaultMachineId(onlineIds, machineId);
    if (next !== machineId) setMachineId(next);
  }, [onlineIds, machineId, initialLocation]);

  // Directory + agent: adopt ONCE, and only while the user hasn't touched the
  // field. These are edited values, not a projection of the store — re-deriving
  // them on every store change would yank the path out from under someone
  // mid-type (which is why this is a latch, not the machine effect's pattern).
  const dirAdopted = useRef(Boolean(initialLocation));
  const firstPreset = list[0];
  useEffect(() => {
    if (dirAdopted.current) return;
    if (directory !== '') { dirAdopted.current = true; return; } // user typed / prefilled
    if (!firstPreset) return;                                    // presets not in yet
    dirAdopted.current = true;
    setDirectory(firstPreset.path);
    setEditingId(firstPreset.id);
  }, [firstPreset, directory]);

  const agentAdopted = useRef(false);
  useEffect(() => {
    if (agentAdopted.current) return;
    if (defaultAgent === undefined) return;   // setting hasn't landed yet
    agentAdopted.current = true;
    setAgent(normalizeAgentKey(defaultAgent));
  }, [defaultAgent]);

  const trimmed = directory.trim();

  // The daemon's spawn doesn't expand a leading ~, so resolve it here using the
  // selected machine's reported home dir. Avoids a bogus "create directory ~/…"
  // prompt for paths that actually exist.
  const selectedMachine = online.find((m) => m.id === machineId);
  const agentsToSetUp = agentsNeedingSetup(selectedMachine?.metadata);
  // Derived, not stored: switching machines or the agent becoming available hides the row.
  const shownSetupAgent = setupAgent && agentsToSetUp.includes(setupAgent) ? setupAgent : null;
  const shownSetupInstruction = shownSetupAgent ? agentSetupInstruction(shownSetupAgent) : null;
  const outdatedAgents = useMemo(() => new Set(
    (readAgentVersions(selectedMachine?.daemonState)?.agents ?? []).filter((v) => v.status === 'update-available').map((v) => v.id),
  ), [selectedMachine?.daemonState]);
  const homeDir = (selectedMachine as any)?.metadata?.homeDir as string | undefined;
  const selectedAgentAvailability = resolveAgentAvailability(selectedMachine?.metadata, agent);
  // B-301: the daemon publishes its Claude login state, but until now only the
  // machine page read it — so the launcher would start a Claude session on a
  // machine whose login was dead and the user found out when the turn failed.
  // This warns; it deliberately does NOT block. The state can lag a login the
  // user just completed, and a launcher that refuses on stale evidence is worse
  // than one that says what it knows.
  const selectedClaudeAuth = claudeAuthNotice(selectedMachine, agent);
  // B-586: 「在新 worktree 中」 — machine capability gate + the daemon's repo info.
  const worktreeSupported = machineSupportsWorktrees(selectedMachine);
  const [worktree, setWorktreeState] = useState<WorktreeDraft>(EMPTY_WORKTREE_DRAFT);
  const setWorktree = useCallback((next: WorktreeDraft) => setWorktreeState(next), []);
  const worktreeActive = worktree.enabled && worktreeSupported;
  const worktreeInfoState = useWorktreeInfo(machineId, resolveDir(trimmed), worktreeActive);
  const [creating, setCreating] = useState<'idle' | 'busy' | 'slow'>('idle');
  const [createError, setCreateError] = useState<string | null>(null);
  const canCreate = !!selectedMachine
    && trimmed.length > 0
    && selectedAgentAvailability.available
    && (!worktreeActive || worktreeDraftReady(worktree, worktreeInfoState))
    && creating === 'idle';

  // Availability can change when a machine is selected or a daemon refreshes
  // its metadata. Never leave the modal pointing at a known-missing external
  // binary; the bundled structured Claude path is the safe fallback.
  useEffect(() => {
    if (!selectedAgentAvailability.available && agent !== 'claude') setAgent('claude');
  }, [agent, selectedAgentAvailability.available]);
  function resolveDir(p: string): string {
    if (!homeDir) return p;
    if (p === '~') return homeDir;
    if (p.startsWith('~/')) return `${homeDir.replace(/\/$/, '')}/${p.slice(2)}`;
    return p;
  }
  const matchesEditing = editingId != null && list.find((p) => p.id === editingId)?.path === trimmed;

  function selectPreset(p: PathPreset) {
    setDirectory(p.path);
    setEditingId(p.id);
  }
  function savePreset() {
    if (!trimmed) return;
    if (editingId) {
      setPresets(list.map((p) => (p.id === editingId ? { ...p, path: trimmed } : p)) as any);
    } else {
      if (list.some((p) => p.path === trimmed)) return;
      const id = newId();
      setPresets([...list, { id, path: trimmed }] as any);
      setEditingId(id);
    }
  }
  function deletePreset(id: string) {
    setPresets(list.filter((p) => p.id !== id) as any);
    if (editingId === id) setEditingId(null);
  }

  // B-516: optimistic open. The pending page owns the spawn, a directory
  // creation approval, the first message (queued in its outbox) and failure;
  // recent-path memory and the Task Board mapping happen on success there.
  const suggested = suggestProjectFor({ machineId, path: directory.trim() }, liveProjects)?.id ?? null;
  const projectId = pickedProject === undefined ? suggested : pickedProject;
  // Offline machines stay listed, disabled, so the picker says why they can't be
  // chosen; a remembered machine this account no longer lists keeps its old row.
  const offlineText = lang.startsWith('zh') ? '离线' : 'Offline';
  const machineOptions: SelectOption[] = [
    ...online.map((m) => ({
      value: m.id,
      label: machineLabel(m),
      ...(hasClaudeAuthNotice(claudeAuthNotice(m, agent)) ? { description: t('newSession.claudeAuthOptionSuffix') } : {}),
    })),
    ...machines.filter((m) => !isMachineOnline(m)).map((m) => ({ value: m.id, label: machineLabel(m), meta: offlineText, disabled: true })),
    ...(machineId && !machines.some((m) => m.id === machineId) ? [{ value: machineId, label: machineLabel(undefined), meta: offlineText, disabled: true }] : []),
  ];
  async function onCreate() {
    if (!canCreate) return;
    let path = resolveDir(trimmed);
    if (worktreeActive) {
      // The worktree must exist before the optimistic page spawns into it.
      setCreating('busy');
      setCreateError(null);
      const slow = setTimeout(() => setCreating((c) => (c === 'busy' ? 'slow' : c)), 200);
      const result = await worktreeCreate(machineId, { path, branch: worktree.branch.trim(), baseRef: worktree.baseRef, location: worktree.location.trim() });
      clearTimeout(slow);
      if (!result.ok) {
        const copy = worktreeCopy(lang);
        setCreateError(result.unsupported ? copy.unsupported : `${copy.createFailed}: ${worktreeErrorText(copy, result.error)}`);
        setCreating('idle');
        return;
      }
      path = result.data.worktreePath;
      // B-585: partial initialization is not fatal — the session still starts there.
      if (result.data.init.initError) toast.show(worktreeCopy(lang).initFailed(result.data.init.initError), 'error');
    }
    newSessionTimingStart('dialog');
    prefetchSessionDetail();
    const record = pendingSessions.create({
      machineId,
      path,
      agent,
      permissionMode: resolveNewSessionPermissionMode(agentDefaultOverrides, agent, reviewFirst),
      source: 'dialog',
      firstMessage: initialCommand,
      ...(spawnedTaskId ? { onSpawnedTask: { taskId: spawnedTaskId } } : {}),
      ...(projectId ? { onSpawnedProject: { projectId } } : {}),
    });
    onClose();
    navigate(`/session/${record.pendingId}`);
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('newSessionModal.eyebrow')}</div>
        <div className="ns-title">{t('newSessionModal.chatTitle')}</div>

        {online.length === 0 ? (
          <NoMachinesNotice onClose={onClose} />
        ) : (
          <>
            <div className="ns-label-row">
              <label className="ns-label" id="ns-machine-label">{t('newSession.machine')}</label>
              <ConnectMachineLink onClose={onClose} />
            </div>
            <Combobox
              label={t('newSession.machine')}
              labelledBy="ns-machine-label"
              size="md"
              value={machineId}
              onChange={setMachineId}
              options={machineOptions}
              leading={machineId ? <span className={`vh-dot ns-machine-dot vh-dot--${onlineIds.includes(machineId) ? 'connected' : 'offline'}`} aria-hidden="true" /> : undefined}
            />
            {selectedClaudeAuth.kind !== 'none' && (
              <div className="ns-machine-warn">
                {selectedClaudeAuth.kind === 'not-logged-in'
                  ? t('newSession.claudeAuthWarnNotLoggedIn')
                  : t('newSession.claudeAuthWarnUnhealthy')}{' '}
                <Link to={`/machine/${machineId}`} onClick={onClose}>
                  {t('session.chat.claudeAuthOpenMachine')}
                </Link>
              </div>
            )}

            {projectsSnap.status === 'ready' && liveProjects.length > 0 && (
              <>
                <label className="ns-label" htmlFor="ns-project">{lang.startsWith('zh') ? '项目' : 'Project'}</label>
                <ProjectPicker id="ns-project" value={projectId ? { kind: 'existing', projectId } : { kind: 'none' }} onChange={(next) => setPickedProject(next.kind === 'existing' ? next.projectId : null)} projects={liveProjects} />
              </>
            )}

            <label className="ns-label">{t('newSession.directory')}</label>

            {list.length > 0 && (
              <div className="ns-presets">
                {list.map((p) => (
                  <span
                    key={p.id}
                    className={`ns-preset${editingId === p.id ? ' is-on' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectPreset(p)}
                  >
                    <span className="ns-preset-path">{p.label || p.path}</span>
                    <button
                      className="ns-preset-x"
                      title={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation();
                        deletePreset(p.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="ns-path-row">
              <input
                className="ns-input"
                value={directory}
                onChange={(e) => {
                  setDirectory(e.target.value);
                  setEditingId(null); // typing a fresh path → save adds a new preset
                }}
                placeholder="~/code/project"
                autoFocus
              />
              <button
                className={`ns-save${matchesEditing ? ' is-saved' : ''}`}
                title={editingId ? t('newSession.updatePreset') : t('newSession.savePreset')}
                disabled={!trimmed}
                onClick={savePreset}
              >
                {matchesEditing ? <Check size={16} /> : <Bookmark size={16} />}
              </button>
            </div>

            <NewWorktreeFields
              lang={lang}
              supported={worktreeSupported}
              draft={worktree}
              onChange={setWorktree}
              info={worktreeInfoState}
            />
            {createError && <div className="nwt-error" role="alert">{createError}</div>}

            <label className="ns-label">{t('newSession.agent')}</label>
            <div className="ns-agents">
              {SESSION_AGENTS.filter((a) => isAgentOffered(selectedMachine?.metadata, a)).map((a) => {
                const availability = resolveAgentAvailability(selectedMachine?.metadata, a);
                const unavailable = !availability.available;
                const suffix = a === 'claude'
                  ? t('newSessionModal.bundledStructured')
                  : unavailable
                    ? t('newSessionModal.notInstalled')
                    // B-719: an installed but outdated harness says so (Update is on the machine page).
                    : outdatedAgents.has(a) ? t('harnessInstall.outdated') : null;
                const showingSetup = unavailable && shownSetupAgent === a;
                return (
                <button
                  key={a}
                  type="button"
                  className={`ns-agent${agent === a ? ' is-on' : ''}${unavailable ? ' is-disabled' : ''}${showingSetup ? ' is-setup' : ''}`}
                  aria-disabled={unavailable}
                  aria-expanded={unavailable ? showingSetup : undefined}
                  aria-controls={unavailable ? 'ns-agent-setup' : undefined}
                  title={unavailable
                    ? t('newSessionModal.agentUnavailableTitle', { agent: a })
                    : undefined}
                  onClick={() => {
                    // Not installed: selecting it reveals how to install it instead of choosing it.
                    if (!unavailable) setAgent(a);
                    else if (a !== 'claude') setSetupAgent(showingSetup ? null : a);
                  }}
                >
                  <span>{a}</span>
                  {suffix && <span className="ns-agent-status">{suffix}</span>}
                </button>
                );
              })}
            </div>
            {agent === 'claude' && (
              <div className="ns-agent-help">
                {t('newSessionModal.bundledClaudeHelp')}{' '}
                <Link to="/docs/configuration#section-claude-credentials">
                  {t('newSessionModal.claudeCredentialHelp')}
                </Link>
              </div>
            )}
            {agentsToSetUp.length > 0 && (shownSetupAgent ? (
              <div className="ns-agent-setup" id="ns-agent-setup">
                {shownSetupInstruction?.kind === 'command' ? (
                  <>
                    {selectedMachine && isHarnessInstallId(shownSetupAgent) && harnessInstallSupported(selectedMachine.metadata) && (
                      // B-719: install it from here; the daemon only accepts the harness id.
                      <AgentSetupInstall key={`${selectedMachine.id}:${shownSetupAgent}`} machineId={selectedMachine.id} harness={shownSetupAgent} daemonState={selectedMachine.daemonState} online={isMachineOnline(selectedMachine)} />
                    )}
                    <div className="ns-agent-help">
                      {shownSetupAgent === 'pi'
                        ? t('newSessionModal.piInstallHelp')
                        : t('newSessionModal.agentInstallHelp', { agent: shownSetupAgent })}
                    </div>
                    <Command value={shownSetupInstruction.command} />
                  </>
                ) : (
                  <div className="ns-agent-help">{t('newSessionModal.openClawSetupHelp')}</div>
                )}
              </div>
            ) : (
              <div className="ns-agent-help">
                {t('newSessionModal.agentSetupPrompt', { agents: agentsToSetUp.join(', ') })}
              </div>
            ))}

            <label className="ns-label">{t('newSession.initialCommand')}</label>
            <textarea
              className="ns-input ns-initial"
              value={initialCommand}
              onChange={(e) => setInitialCommand(e.target.value)}
              placeholder={t('newSession.initialCommandPlaceholder')}
              rows={2}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter from the field = create, matching the send gesture.
                // IME guard: a composition-committing Enter must not create.
                if (ime.isGuarded(e)) return;
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void onCreate(); }
              }}
            />
          </>
        )}

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canCreate} aria-busy={creating !== 'idle' || undefined} onPointerDown={prefetchSessionDetail} onClick={() => { void onCreate(); }}>
            {creating === 'slow' ? <><Spinner size={13} /> {worktreeCopy(lang).creating}</> : t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** B-719: 「这台机器还没装 X，点击安装」 inside the agent picker. */
function AgentSetupInstall({ machineId, harness, daemonState, online }: { machineId: string; harness: HarnessInstallId; daemonState: unknown; online: boolean }) {
  const { t } = useTranslation();
  const action = useHarnessInstall(machineId, harness, daemonState, online);
  return (
    <>
      <div>
        <Button variant="primary" loading={action.installing} disabled={action.disabled} onClick={() => void action.start()}>
          {t('harnessInstall.installOnMachine', { agent: harness })}
        </Button>
      </div>
      {action.status && <div className="ns-agent-help" role="status">{action.status}</div>}
    </>
  );
}
