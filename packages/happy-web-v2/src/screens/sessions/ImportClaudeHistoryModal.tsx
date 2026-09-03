/**
 * ImportClaudeHistoryModal (B-290) — import a Claude Code conversation that
 * was never started through very-happy (claude CLI, the Claude Code desktop
 * app, claude.ai remote sessions, SDK runs). Same shape as AttachTmuxModal:
 * pick the machine (auto when only one is online), see the machine's
 * conversations immediately (newest first, already-tracked ones hidden),
 * click one to import it.
 *
 * Import = copy, not move: one `claude-import-session` RPC forks the
 * transcript and spawns a Happy session that resumes the copy with its history
 * backfilled, deleting the copy again on any failure. The original file stays
 * untouched for the tool that wrote it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { storage, useAllMachines, useAllSessions, useLocalSetting, useSetting } from '@/sync/storage';
import { isMachineOnline, machineLabel, pickDefaultMachineId } from '@/utils/machineUtils';
import { machineImportClaudeSession, machineListClaudeHistory } from '@/sync/ops';
import { claudeHistorySupported } from '@/sync/closedTerminals';
import { resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { recordRecentMachinePath } from '@/app/newChat';
import { Button, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { formatSessionAge } from './newTerminalAttach';
import {
  filterImportableHistory,
  formatHistorySize,
  historyEntrypointLabel,
  historyEntryTitle,
  shortenCwd,
  trackedClaudeSessionIds,
  type ClaudeHistoryEntry,
} from './claudeHistoryImport';
import './newsession.css';

export function ImportClaudeHistoryModal({ onClose, initialMachineId }: {
  onClose: () => void;
  /** Preselect this machine (the machine page opens the dialog for its own
   *  machine; without this the picker would default to the newest one). */
  initialMachineId?: string;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const sessions = useAllSessions();
  const agentDefaultOverrides = useSetting('agentDefaultOverrides');
  const reviewFirst = useLocalSetting('newSessionReviewFirst');

  const [machineId, setMachineId] = useState(() => pickDefaultMachineId(online.map((m) => m.id), initialMachineId));
  const [entries, setEntries] = useState<ClaudeHistoryEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);

  // Same cold-start re-derive as NewTerminalModal (B-146).
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    const next = pickDefaultMachineId(onlineIds, machineId || initialMachineId);
    if (next !== machineId) setMachineId(next);
  }, [initialMachineId, onlineIds, machineId]);

  const machine = online.find((m) => m.id === machineId);
  const homeDir = (machine as any)?.metadata?.homeDir as string | undefined;
  const supported = !!machine && claudeHistorySupported((machine as any).daemonState);
  // Conversations very-happy already owns (on any machine): sent to the daemon
  // as `exclude` so the scan skips them, and filtered again client-side for
  // sessions that land after the fetch.
  const tracked = useMemo(() => trackedClaudeSessionIds(sessions), [sessions]);

  useEffect(() => {
    setEntries([]);
    setTruncated(false);
    setLoadError(null);
    if (!machineId || !supported) return;
    let cancelled = false;
    setLoading(true);
    machineListClaudeHistory(machineId, { limit: 100, exclude: tracked })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) { setLoadError(result.message ?? ''); return; }
        setEntries(result.entries);
        setTruncated(result.truncated);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `tracked` is deliberately not a dependency: it changes the moment an
    // import lands and would refetch the whole list mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, supported]);

  const visible = useMemo(() => filterImportableHistory(entries, tracked, query), [entries, tracked, query]);

  async function importEntry(entry: ClaudeHistoryEntry, approved = false) {
    // The machine can drop between the listing and the click (B-146 rule).
    const live = storage.getState().machines[machineId];
    if (!live || !isMachineOnline(live)) {
      toast.error(t('newSession.machineOffline'));
      return;
    }
    const permissionMode = resolveNewSessionPermissionMode(agentDefaultOverrides, 'claude', reviewFirst);
    const res = await machineImportClaudeSession({
      machineId,
      directory: entry.cwd,
      claudeSessionId: entry.claudeSessionId,
      approvedNewDirectoryCreation: approved,
      permissionMode,
    });
    // A transcript often names a directory that no longer exists (a checkout
    // that moved, a /tmp workspace). Offer to recreate it instead of failing
    // with a generic error — the daemon has already discarded its copy, so a
    // confirmed retry starts from a clean fork.
    if (res.type === 'requestToApproveDirectoryCreation') {
      const ok = await Modal.confirm(
        t('newSession.createDirTitle'),
        t('newSession.createDirMessage', { directory: res.directory }),
        { confirmText: t('common.create') },
      );
      if (ok) return importEntry(entry, true);
      return;
    }
    if (res.type !== 'success') {
      toast.error(res.errorMessage || t('importClaudeHistory.failed'));
      return;
    }
    storage.getState().updateSessionPermissionMode(res.sessionId, permissionMode);
    recordRecentMachinePath(machineId, entry.cwd);
    toast.success(t('importClaudeHistory.imported'));
    onClose();
    navigate(`/session/${res.sessionId}`);
  }

  async function onRowActivate(entry: ClaudeHistoryEntry) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(entry.claudeSessionId);
    try {
      await importEntry(entry);
    } catch (e: any) {
      toast.error(e?.message || t('importClaudeHistory.failed'));
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  const now = Date.now();
  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card ns-card--wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('importClaudeHistory.eyebrow')}</div>
        <div className="ns-title">{t('importClaudeHistory.title')}</div>
        <div className="ns-hint" style={{ marginTop: 0 }}>{t('importClaudeHistory.intro')}</div>

        {online.length === 0 ? (
          <div className="ns-empty">{t('machine.noMachines')}</div>
        ) : (
          <>
            {online.length > 1 && (
              <>
                <label className="ns-label">{t('newSession.machine')}</label>
                <select className="ns-select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                  {online.map((m) => (
                    <option key={m.id} value={m.id}>{machineLabel(m)}</option>
                  ))}
                </select>
              </>
            )}

            {!supported ? (
              <div className="ns-hint">{t('importClaudeHistory.needsCli')}</div>
            ) : loadError !== null ? (
              <div className="ns-hint">{t('importClaudeHistory.loadFailed')}{loadError ? ` · ${loadError}` : ''}</div>
            ) : loading && entries.length === 0 ? (
              <div className="ns-hint">{t('importClaudeHistory.loading')}</div>
            ) : entries.length === 0 ? (
              <div className="ns-hint">{t('importClaudeHistory.empty')}</div>
            ) : (
              <>
                <div className="ns-path-row">
                  <Search size={14} className="ns-search-icon" aria-hidden="true" />
                  <input
                    className="ns-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('importClaudeHistory.searchPlaceholder')}
                    aria-label={t('importClaudeHistory.searchPlaceholder')}
                    autoFocus
                  />
                </div>
                {visible.length === 0 ? (
                  <div className="ns-hint">{t('importClaudeHistory.noMatch')}</div>
                ) : (
                  <div className="ns-sessions ns-sessions--tall" role="listbox" aria-label={t('importClaudeHistory.title')}>
                    {visible.map((entry) => {
                      const age = formatSessionAge(entry.updatedAt, now);
                      const source = historyEntrypointLabel(entry.entrypoint);
                      const importing = busyId === entry.claudeSessionId;
                      return (
                        <div
                          key={entry.claudeSessionId}
                          className={`ns-session ns-session--stack${importing ? ' is-on' : ''}`}
                          role="option"
                          aria-selected={importing}
                          tabIndex={0}
                          aria-disabled={busyId !== null}
                          aria-busy={importing}
                          onClick={() => void onRowActivate(entry)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void onRowActivate(entry); }
                          }}
                        >
                          <span className="ns-session-name" title={entry.firstPrompt}>{historyEntryTitle(entry)}</span>
                          <span className="ns-session-meta mono" title={entry.cwd}>
                            {shortenCwd(entry.cwd, homeDir)}
                            {entry.gitBranch ? ` · ${entry.gitBranch}` : ''}
                            {source ? ` · ${source}` : ''}
                            {` · ${formatHistorySize(entry.sizeBytes)}`}
                            {age ? ` · ${age}` : ''}
                            {importing ? ` · ${t('importClaudeHistory.importing')}` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {truncated && <div className="ns-hint">{t('importClaudeHistory.truncated')}</div>}
                <div className="ns-hint">{t('importClaudeHistory.copyNote')}</div>
              </>
            )}
          </>
        )}

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </div>
    </div>
  );
}
