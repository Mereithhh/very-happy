/**
 * ImportHistoryModal (B-290, batch + progress in B-294, Codex in B-464) —
 * import conversations that were never started through very-happy:
 *
 *  - Claude Code: claude CLI, the Claude Code desktop app, claude.ai remote
 *    sessions, SDK runs — `~/.claude/projects/<cwd>/<id>.jsonl`.
 *  - Codex: the codex TUI, `codex exec`, the Codex desktop app / IDE
 *    extension — `~/.codex/sessions/<date>/rollout-*-<id>.jsonl`.
 *
 * Pick the source and the machine (auto when only one is online), select one
 * or more of its untracked conversations, and import them in one run. Import
 * = copy, not move. Claude: one `claude-import-session` RPC forks the
 * transcript and spawns a Happy session resuming the copy, deleting the copy
 * again on any failure. Codex: one `codex-import-session` RPC spawns a Codex
 * session whose wrapper forks the thread through the app-server and continues
 * on the fork. Either way the original stays untouched for the tool that
 * wrote it.
 *
 * The run is sequential on purpose: every import spawns a CLI process on the
 * machine, and a burst of them would race for the same daemon and hit the
 * account's write limits. Each row shows its own state so a long run stays
 * legible.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Search } from 'lucide-react';
import { storage, useAllMachines, useLocalSetting, useSetting } from '@/sync/storage';
import { isMachineOnline, machineLabel, pickDefaultMachineId } from '@/utils/machineUtils';
import { machineImportClaudeSession, machineImportCodexSession, machineListClaudeHistory, machineListCodexHistory, sessionUpdateTitle } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { claudeHistorySupported, codexHistorySupported } from '@/sync/closedTerminals';
import { resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { resolveAgentAvailability } from '@/utils/agentAvailability';
import { recordRecentMachinePath } from '@/app/newChat';
import { Button, Spinner, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { NoMachinesNotice } from './NoMachinesNotice';
import { formatSessionAge } from './newTerminalAttach';
import {
  filterImportableHistory,
  formatHistorySize,
  historySourceLabel,
  historyEntryTitle,
  orderSelectionForImport,
  pruneImportSelection,
  shortenCwd,
  summarizeImportRun,
  toggleImportSelection,
  trackedHistoryIds,
  type HistoryAgent,
  type HistoryEntry,
  type ImportRowState,
} from './claudeHistoryImport';
import './newsession.css';

export type ImportHistoryAgent = HistoryAgent;

const AGENTS: readonly HistoryAgent[] = ['claude', 'codex'];

export function ImportHistoryModal({ onClose, initialMachineId, initialAgent = 'claude' }: {
  onClose: () => void;
  /** Preselect this machine (the machine page opens the dialog for its own
   *  machine; without this the picker would default to the newest one). */
  initialMachineId?: string;
  /** Which source the dialog opens on; the user can switch inside. */
  initialAgent?: HistoryAgent;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  // Raw record, not useAllSessions(): that lane hides mirror sessions (every
  // claude started by hand in a web terminal is one), and those are exactly the
  // conversations very-happy already owns — B-291. The daemon excludes its own
  // record too; this keeps the list honest between fetches.
  const sessionsById = storage((state) => state.sessions);
  const agentDefaultOverrides = useSetting('agentDefaultOverrides');
  const reviewFirst = useLocalSetting('newSessionReviewFirst');

  const [agent, setAgent] = useState<HistoryAgent>(initialAgent);
  const [machineId, setMachineId] = useState(() => pickDefaultMachineId(online.map((m) => m.id), initialMachineId));
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [rowStates, setRowStates] = useState<Map<string, ImportRowState>>(new Map());
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  // Same cold-start re-derive as NewTerminalModal (B-146).
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    const next = pickDefaultMachineId(onlineIds, machineId || initialMachineId);
    if (next !== machineId) setMachineId(next);
  }, [initialMachineId, onlineIds, machineId]);

  const machine = online.find((m) => m.id === machineId);
  const homeDir = (machine as any)?.metadata?.homeDir as string | undefined;
  const daemonState = (machine as any)?.daemonState;
  const supported = !!machine && (agent === 'claude' ? claudeHistorySupported(daemonState) : codexHistorySupported(daemonState));
  // Codex is not bundled: a machine without it can list its rollouts but could
  // not continue an import. Say so instead of failing at spawn.
  const codexMissing = agent === 'codex' && !!machine && !resolveAgentAvailability((machine as any).metadata, 'codex').available;
  const tracked = useMemo(() => trackedHistoryIds(agent, Object.values(sessionsById)), [agent, sessionsById]);

  useEffect(() => {
    setEntries([]);
    setTruncated(false);
    setLoadError(null);
    setSelected([]);
    setRowStates(new Map());
    setQuery('');
    if (!machineId || !supported) return;
    let cancelled = false;
    setLoading(true);
    const request = agent === 'claude'
      ? machineListClaudeHistory(machineId, { limit: 100, exclude: tracked })
      : machineListCodexHistory(machineId, { limit: 100, exclude: tracked });
    request
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) { setLoadError(result.message ?? ''); return; }
        setEntries(result.entries);
        setTruncated(result.truncated);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `tracked` is deliberately not a dependency: it changes the moment an
    // import lands and would refetch the whole list mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, machineId, supported]);

  const visible = useMemo(() => filterImportableHistory(entries, tracked, query), [entries, tracked, query]);

  // A row filtered out by a new search must not stay counted in the footer.
  useEffect(() => {
    if (running) return;
    setSelected((current) => {
      const pruned = pruneImportSelection(current, visible);
      return pruned.length === current.length ? current : pruned;
    });
  }, [running, visible]);

  function setRowState(id: string, state: ImportRowState) {
    setRowStates((current) => new Map(current).set(id, state));
  }

  /** Old daemons ignore the title passed to the import RPC, and the CLI's own
   *  title generator never fires for an imported session (it only runs on a new
   *  user message). Set it from here once the session lands, unless the CLI
   *  already did — a no-op on current daemons. */
  async function ensureTitle(sessionId: string, title: string): Promise<void> {
    if (!title) return;
    try {
      if (!storage.getState().sessions[sessionId]) await sync.refreshSessions();
      if (storage.getState().sessions[sessionId]?.metadata?.summary?.text) return;
      await sessionUpdateTitle(sessionId, title);
    } catch {
      // Cosmetic only: an untitled imported session is still fully usable.
    }
  }

  /** One conversation. Returns the new session id, or null when it failed or
   *  the user declined to create the missing directory. */
  async function importOne(entry: HistoryEntry, approved = false): Promise<string | null> {
    const live = storage.getState().machines[machineId];
    if (!live || !isMachineOnline(live)) {
      setRowState(entry.id, { kind: 'failed', message: t('newSession.machineOffline') });
      return null;
    }
    const title = historyEntryTitle(entry);
    const permissionMode = resolveNewSessionPermissionMode(agentDefaultOverrides, entry.agent, reviewFirst);
    const common = { machineId, directory: entry.cwd, approvedNewDirectoryCreation: approved, permissionMode, title };
    const res = entry.agent === 'claude'
      ? await machineImportClaudeSession({ ...common, claudeSessionId: entry.claudeSessionId })
      : await machineImportCodexSession({ ...common, codexThreadId: entry.codexThreadId });
    // A transcript often names a directory that no longer exists (a checkout
    // that moved, a /tmp workspace). Offer to recreate it instead of failing
    // with a generic error — nothing has been created yet on the machine, so a
    // confirmed retry starts clean.
    if (res.type === 'requestToApproveDirectoryCreation') {
      const ok = await Modal.confirm(
        t('newSession.createDirTitle'),
        t('newSession.createDirMessage', { directory: res.directory }),
        { confirmText: t('common.create') },
      );
      if (ok) return importOne(entry, true);
      setRowState(entry.id, { kind: 'failed', message: t('importClaudeHistory.skippedNoDirectory') });
      return null;
    }
    if (res.type !== 'success') {
      setRowState(entry.id, { kind: 'failed', message: res.errorMessage });
      return null;
    }
    storage.getState().updateSessionPermissionMode(res.sessionId, permissionMode);
    recordRecentMachinePath(machineId, entry.cwd);
    setRowState(entry.id, { kind: 'done', sessionId: res.sessionId });
    void ensureTitle(res.sessionId, title);
    return res.sessionId;
  }

  async function runImport() {
    if (runningRef.current) return;
    const batch = orderSelectionForImport(selected, visible);
    if (batch.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    setRowStates(new Map(batch.map((e) => [e.id, { kind: 'queued' } as ImportRowState])));
    try {
      for (const entry of batch) {
        setRowState(entry.id, { kind: 'running' });
        try {
          await importOne(entry);
        } catch (e: any) {
          setRowState(entry.id, { kind: 'failed', message: e?.message });
        }
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  // Report the run once it settles: one clean import goes straight to the new
  // chat; anything else keeps the dialog open so failures stay readable.
  const summary = useMemo(() => summarizeImportRun(rowStates), [rowStates]);
  useEffect(() => {
    if (running || summary.total === 0) return;
    if (summary.done + summary.failed !== summary.total) return;
    if (summary.failed > 0) {
      toast.error(t('importClaudeHistory.batchPartial', { done: summary.done, failed: summary.failed }));
      return;
    }
    toast.success(summary.done === 1
      ? t('importClaudeHistory.imported')
      : t('importClaudeHistory.batchImported', { count: summary.done }));
    onClose();
    if (summary.singleSessionId) navigate(`/session/${summary.singleSessionId}`);
    // Fires once, when the run settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, summary.done, summary.failed, summary.total]);

  const copy = agent === 'claude' ? {
    title: t('importClaudeHistory.title'),
    intro: t('importClaudeHistory.intro'),
    needsCli: t('importClaudeHistory.needsCli'),
    loading: t('importClaudeHistory.loading'),
    empty: t('importClaudeHistory.empty'),
    loadFailed: t('importClaudeHistory.loadFailed'),
    copyNote: t('importClaudeHistory.copyNote'),
  } : {
    title: t('importClaudeHistory.codexTitle'),
    intro: t('importClaudeHistory.codexIntro'),
    needsCli: t('importClaudeHistory.codexNeedsCli'),
    loading: t('importClaudeHistory.codexLoading'),
    empty: t('importClaudeHistory.codexEmpty'),
    loadFailed: t('importClaudeHistory.codexLoadFailed'),
    copyNote: t('importClaudeHistory.codexCopyNote'),
  };
  const agentLabel = (a: HistoryAgent) => a === 'claude' ? t('importClaudeHistory.agentClaude') : t('importClaudeHistory.agentCodex');

  const now = Date.now();
  const progressed = summary.done + summary.failed;
  return (
    <div className="ns-backdrop" onClick={running ? undefined : onClose}>
      <div className="ns-card ns-card--wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('importClaudeHistory.eyebrow')}</div>
        <div className="ns-title">{copy.title}</div>
        <div className="ns-hint" style={{ marginTop: 0 }}>{copy.intro}</div>

        {online.length === 0 ? (
          <NoMachinesNotice onClose={onClose} />
        ) : (
          <>
            <label className="ns-label">{t('importClaudeHistory.agentLabel')}</label>
            <div className="ns-agents" role="radiogroup" aria-label={t('importClaudeHistory.agentLabel')}>
              {AGENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={agent === a}
                  className={`ns-agent${agent === a ? ' is-on' : ''}`}
                  disabled={running}
                  onClick={() => setAgent(a)}
                >
                  {agentLabel(a)}
                </button>
              ))}
            </div>

            {online.length > 1 && (
              <>
                <label className="ns-label">{t('newSession.machine')}</label>
                <select className="ns-select" value={machineId} disabled={running} onChange={(e) => setMachineId(e.target.value)}>
                  {online.map((m) => (
                    <option key={m.id} value={m.id}>{machineLabel(m)}</option>
                  ))}
                </select>
              </>
            )}

            {!supported ? (
              <div className="ns-hint">{copy.needsCli}</div>
            ) : loadError !== null ? (
              <div className="ns-hint">{copy.loadFailed}{loadError ? ` · ${loadError}` : ''}</div>
            ) : loading && entries.length === 0 ? (
              <div className="ns-loading-row"><Spinner size={14} /><span>{copy.loading}</span></div>
            ) : entries.length === 0 ? (
              <div className="ns-hint">{copy.empty}</div>
            ) : (
              <>
                {codexMissing && <div className="ns-hint">{t('importClaudeHistory.codexNotInstalled')}</div>}
                <div className="ns-path-row">
                  <Search size={14} className="ns-search-icon" aria-hidden="true" />
                  <input
                    className="ns-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('importClaudeHistory.searchPlaceholder')}
                    aria-label={t('importClaudeHistory.searchPlaceholder')}
                    disabled={running}
                    autoFocus
                  />
                </div>
                {visible.length === 0 ? (
                  <div className="ns-hint">{t('importClaudeHistory.noMatch')}</div>
                ) : (
                  <div className="ns-sessions ns-sessions--tall" role="listbox" aria-multiselectable="true" aria-label={copy.title}>
                    {visible.map((entry) => {
                      const age = formatSessionAge(entry.updatedAt, now);
                      const source = historySourceLabel(entry);
                      const state = rowStates.get(entry.id) ?? { kind: 'idle' as const };
                      const isSelected = selected.includes(entry.id);
                      const statusLabel = state.kind === 'running' ? t('importClaudeHistory.importing')
                        : state.kind === 'queued' ? t('importClaudeHistory.queued')
                          : state.kind === 'done' ? t('importClaudeHistory.rowDone')
                            : state.kind === 'failed' ? `${t('importClaudeHistory.rowFailed')}${state.message ? `: ${state.message}` : ''}`
                              : null;
                      const toggle = () => {
                        if (running) return;
                        setSelected((current) => toggleImportSelection(current, entry.id));
                      };
                      return (
                        <div
                          key={entry.id}
                          className={`ns-session ns-session--stack${isSelected ? ' is-on' : ''}${state.kind === 'failed' ? ' is-failed' : ''}`}
                          role="option"
                          aria-selected={isSelected}
                          tabIndex={0}
                          aria-disabled={running}
                          aria-busy={state.kind === 'running'}
                          onClick={toggle}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                          }}
                        >
                          <span className="ns-session-name" title={entry.firstPrompt}>
                            {state.kind === 'running'
                              ? <Spinner size={12} />
                              : isSelected && <Check size={12} aria-hidden="true" />}
                            {historyEntryTitle(entry)}
                          </span>
                          <span className="ns-session-meta mono" title={entry.cwd}>
                            {shortenCwd(entry.cwd, homeDir)}
                            {entry.gitBranch ? ` · ${entry.gitBranch}` : ''}
                            {source ? ` · ${source}` : ''}
                            {` · ${formatHistorySize(entry.sizeBytes)}`}
                            {age ? ` · ${age}` : ''}
                            {statusLabel ? ` · ${statusLabel}` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {truncated && <div className="ns-hint">{t('importClaudeHistory.truncated')}</div>}
                <div className="ns-hint">{copy.copyNote}</div>
              </>
            )}
          </>
        )}

        <div className="ns-actions">
          {running && (
            <span className="ns-progress mono" aria-live="polite">
              {t('importClaudeHistory.progress', { done: progressed, total: summary.total })}
            </span>
          )}
          <Button variant="ghost" disabled={running} onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={running}
            disabled={running || selected.length === 0 || codexMissing}
            onClick={() => void runImport()}
          >
            {t('importClaudeHistory.importAction', { count: selected.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
