import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bookmark, Check, X } from 'lucide-react';
import { storage, useAllMachines, useLocalSetting, useSetting, useSettingMutable } from '@/sync/storage';
import { isMachineOnline, pickDefaultMachineId } from '@/utils/machineUtils';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { recordRecentMachinePath } from '@/app/newChat';
import { machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { Button, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { ConnectMachineLink, NoMachinesNotice } from './NoMachinesNotice';
import { claudeAuthNotice, hasClaudeAuthNotice } from './claudeAuthNotice';
import { useImeGuard } from '@/utils/ime';
import {
  agentSetupInstruction,
  resolveAgentAvailability,
  SESSION_AGENTS,
  type SessionAgent,
} from '@/utils/agentAvailability';
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
  onSpawned,
}: {
  onClose: () => void;
  /** Prefill for the initial-instruction field (Task Board dispatch passes
   *  the task description so it becomes the session's first message). */
  initialCommandDefault?: string;
  /** Called with the new sessionId right after a successful spawn (before
   *  navigation) — Task Board uses it to record the task→session mapping. */
  onSpawned?: (sessionId: string) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const [presets, setPresets] = useSettingMutable('sessionPathPresets');
  const list = (presets as PathPreset[] | undefined) ?? [];

  const defaultAgent = useSetting('newSessionAgent');
  const agentDefaultOverrides = useSetting('agentDefaultOverrides');
  const reviewFirst = useLocalSetting('newSessionReviewFirst');

  const [machineId, setMachineId] = useState('');
  const [directory, setDirectory] = useState(list[0]?.path ?? '');
  const [editingId, setEditingId] = useState<string | null>(list[0]?.id ?? null);
  const [agent, setAgent] = useState<SessionAgent>(() => normalizeAgentKey(defaultAgent));
  const [initialCommand, setInitialCommand] = useState(initialCommandDefault ?? '');
  const ime = useImeGuard();
  const [busy, setBusy] = useState(false);

  // ── B-147: nothing derived from the stores may live in a useState initializer.
  // `useAllMachines` answers [] until the store is hydrated (storage.ts's
  // `!isDataReady` guard) and settings can be overwritten by a later server
  // sync, so every initializer below used to freeze at a pre-hydration value:
  // machineId at '' (→ <select> matches no option, `canCreate` false FOREVER,
  // Create permanently disabled on a cold start — the exact bug B-146 fixed in
  // the terminal dialog), and directory/agent at "no presets / default agent"
  // even after the real values arrived.
  //
  // Machine: re-derive on every change of the online set. Passing `machineId` as
  // preferred makes it idempotent once a live machine is selected (no setState
  // loop) and re-picks when the chosen machine drops off.
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    const next = pickDefaultMachineId(onlineIds, machineId);
    if (next !== machineId) setMachineId(next);
  }, [onlineIds, machineId]);

  // Directory + agent: adopt ONCE, and only while the user hasn't touched the
  // field. These are edited values, not a projection of the store — re-deriving
  // them on every store change would yank the path out from under someone
  // mid-type (which is why this is a latch, not the machine effect's pattern).
  const dirAdopted = useRef(false);
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
  const homeDir = (selectedMachine as any)?.metadata?.homeDir as string | undefined;
  const selectedAgentAvailability = resolveAgentAvailability(selectedMachine?.metadata, agent);
  // B-301: the daemon publishes its Claude login state, but until now only the
  // machine page read it — so the launcher would start a Claude session on a
  // machine whose login was dead and the user found out when the turn failed.
  // This warns; it deliberately does NOT block. The state can lag a login the
  // user just completed, and a launcher that refuses on stale evidence is worse
  // than one that says what it knows.
  const selectedClaudeAuth = claudeAuthNotice(selectedMachine, agent);
  const canCreate = !!machineId
    && trimmed.length > 0
    && selectedAgentAvailability.available
    && !busy;

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

  async function spawn(approve = false) {
    const permissionMode = resolveNewSessionPermissionMode(agentDefaultOverrides, agent, reviewFirst);
    const res = await machineSpawnNewSession({
      machineId,
      directory: resolveDir(trimmed),
      agent,
      permissionMode,
      approvedNewDirectoryCreation: approve,
    });
    if (res.type === 'requestToApproveDirectoryCreation') {
      const ok = await Modal.confirm(
        t('newSession.createDirTitle'),
        t('newSession.createDirMessage', { directory: res.directory }),
        { confirmText: t('common.create') },
      );
      if (ok) return spawn(true);
      return null;
    }
    if (res.type === 'error') {
      toast.error(res.errorMessage || t('errors.networkError'));
      return null;
    }
    storage.getState().updateSessionPermissionMode(res.sessionId, permissionMode);
    return res.sessionId;
  }

  async function onCreate() {
    if (!canCreate) return;
    setBusy(true);
    try {
      const sessionId = await spawn(false);
      if (sessionId) {
        // Teach the quick "+" path: the next new chat reuses this
        // machine+directory directly, without this dialog.
        recordRecentMachinePath(machineId, resolveDir(trimmed));
        onSpawned?.(sessionId);
        // Optional initial instruction: fire it as the first chat message once
        // the session exists. sendMessage awaits the sessions-sync queue, so it
        // safely waits for the just-spawned session's encryption/storage to land
        // before sending — no need to block navigation on it.
        const first = initialCommand.trim();
        if (first) void sync.sendMessage(sessionId, first, { source: 'chat' });
        onClose();
        navigate(`/session/${sessionId}`);
      }
    } catch (e: any) {
      toast.error(e?.message || t('errors.networkError'));
    } finally {
      setBusy(false);
    }
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
              <label className="ns-label">{t('newSession.machine')}</label>
              <ConnectMachineLink onClose={onClose} />
            </div>
            <select className="ns-select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {online.map((m) => (
                <option key={m.id} value={m.id}>
                  {/* A native <option> can only carry text, so the marker is
                    * appended to the label rather than rendered as a chip. */}
                  {hasClaudeAuthNotice(claudeAuthNotice(m, agent))
                    ? `${machineLabel(m)} · ${t('newSession.claudeAuthOptionSuffix')}`
                    : machineLabel(m)}
                </option>
              ))}
            </select>
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

            <label className="ns-label">{t('newSession.agent')}</label>
            <div className="ns-agents">
              {SESSION_AGENTS.map((a) => {
                const availability = resolveAgentAvailability(selectedMachine?.metadata, a);
                const unavailable = !availability.available;
                const suffix = a === 'claude'
                  ? t('newSessionModal.bundledStructured')
                  : unavailable
                    ? t('newSessionModal.notInstalled')
                    : null;
                return (
                <button
                  key={a}
                  type="button"
                  className={`ns-agent${agent === a ? ' is-on' : ''}${unavailable ? ' is-disabled' : ''}`}
                  disabled={unavailable}
                  aria-disabled={unavailable}
                  title={unavailable
                    ? t('newSessionModal.agentUnavailableTitle', { agent: a })
                    : undefined}
                  onClick={() => setAgent(a)}
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
            {selectedMachine?.metadata?.cliAvailability && (
              <div className="ns-agent-help">
                {[
                  ...SESSION_AGENTS
                      .filter((candidate): candidate is Exclude<SessionAgent, 'claude'> => candidate !== 'claude')
                      .filter((candidate) => !resolveAgentAvailability(selectedMachine.metadata, candidate).available)
                      .map((candidate) => {
                        const setup = agentSetupInstruction(candidate);
                        return setup.kind === 'command'
                          ? t('newSessionModal.agentInstallHelp', { agent: candidate, command: setup.command })
                          : t('newSessionModal.openClawSetupHelp');
                      }),
                ].filter(Boolean).join(' · ')}
              </div>
            )}

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
          <Button variant="primary" loading={busy} disabled={!canCreate} onClick={onCreate}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}
