/**
 * NewTerminalModal (B-144) — "new terminal in a directory".
 *
 * The plain new-terminal entry points (⌘N / ⌥N, the "+" menu's Web terminal,
 * the palette) stay one-click: they create in the machine's home directory.
 * This dialog is the deliberate variant — choose the working directory FIRST,
 * so the configured terminal startup command (Settings → Terminal) starts in
 * the right project instead of $HOME.
 *
 * Nothing new on the wire: it ends in the same createTerminalAt() the archive
 * view already uses (B-084), which forwards `cwd` into the existing
 * open-terminal RPC — the daemon has always done `tmux new-session -c <cwd>`.
 *
 * The saved directories are the SAME `sessionPathPresets` the chat dialog
 * edits, so one curated list serves both. Path arithmetic lives in
 * utils/terminalCwd.ts (unit-tested); this file is wiring only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, Check, FolderOpen, X } from 'lucide-react';
import { useAllMachines, useLocalSettingMutable, useSettingMutable } from '@/sync/storage';
import { isMachineOnline, machineLabel, pickDefaultMachineId } from '@/utils/machineUtils';
import { createTerminalAt } from '@/app/newTerminal';
import { machineFsList } from '@/sync/fsOps';
import { machineListTmuxSessions } from '@/sync/ops';
import { tmuxSessionsSupported } from '@/sync/closedTerminals';
import {
  attachSectionVisible,
  formatSessionAge,
  primaryLabelKey,
  TMUX_TIPS_HINT_KEY,
  tipsCardVisible,
  toggleAttachSelection,
  type UserTmuxSession,
} from './newTerminalAttach';
import { FsBrowser } from '@/screens/files/FsBrowser';
import { fsFailureText } from '@/screens/files/fsFailureText';
import { Button, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import {
  expandHomePath,
  normalizeCwdInput,
  removePathPreset,
  upsertPathPreset,
  type PathPreset,
} from '@/utils/terminalCwd';
import './newsession.css';

function newId(): string {
  const c = (globalThis as any).crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
}

export function NewTerminalModal({ onClose, intent }: {
  onClose: () => void;
  /** B-280: 'attach' = opened from the dedicated "attach a tmux session"
   *  entry — the section is the point, so an unsupported daemon gets a hint
   *  instead of silence. */
  intent?: 'attach';
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const [presets, setPresets] = useSettingMutable('sessionPathPresets');
  const list = (presets as PathPreset[] | undefined) ?? [];

  const [machineId, setMachineId] = useState(() => pickDefaultMachineId(online.map((m) => m.id)));
  const [directory, setDirectory] = useState(list[0]?.path ?? '~');
  const [editingId, setEditingId] = useState<string | null>(list[0]?.id ?? null);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  // B-273: attach an existing tmux session. `loadingSessions` is deliberately
  // NOT `busy` — the list fetch must never lock the plain "Open terminal".
  const [sessions, setSessions] = useState<UserTmuxSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [attachId, setAttachId] = useState<string | null>(null);
  const [dismissedHints, setDismissedHints] = useLocalSettingMutable('dismissedHints');
  const showTips = tipsCardVisible(dismissedHints);

  // B-146: useAllMachines answers [] until the store is hydrated
  // (storage.ts's `!isDataReady` guard), so the useState initializer above can
  // freeze machineId at ''. Left alone, the <select> then matches no option and
  // `canCreate` stays false FOREVER — Create permanently disabled on a cold
  // start. Re-derive whenever the online set changes; `machineId` as the
  // preferred value makes this a no-op once a live machine is selected, and it
  // also re-picks when the chosen machine drops off.
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    const next = pickDefaultMachineId(onlineIds, machineId);
    if (next !== machineId) setMachineId(next);
  }, [onlineIds, machineId]);

  const trimmed = normalizeCwdInput(directory);
  const machine = online.find((m) => m.id === machineId);
  const attachSupported = !!machine && tmuxSessionsSupported((machine as any).daemonState);
  const attachSelected = attachId ? sessions.find((s) => s.id === attachId) : undefined;
  // Attaching ignores the directory, so an empty path must not block it.
  const canCreate = !!machineId && (!!attachSelected || trimmed.length > 0) && !busy;
  const homeDir = (machine as any)?.metadata?.homeDir as string | undefined;

  // Fetch the machine's tmux sessions once per (open, machine); a machine
  // switch clears the selection — the ids belong to the old server.
  useEffect(() => {
    setAttachId(null);
    setSessions([]);
    if (!machineId || !attachSupported) return;
    let cancelled = false;
    setLoadingSessions(true);
    machineListTmuxSessions(machineId)
      .then((list) => { if (!cancelled) setSessions(list); })
      .finally(() => { if (!cancelled) setLoadingSessions(false); });
    return () => { cancelled = true; };
  }, [machineId, attachSupported]);
  const matchesEditing = editingId != null && list.find((p) => p.id === editingId)?.path === trimmed;

  function savePreset() {
    const res = upsertPathPreset(list, trimmed, editingId, newId);
    if (!res) return;
    setPresets(res.list as any);
    setEditingId(res.id);
  }

  async function onCreate() {
    if (!canCreate) return;
    setBusy(true);
    try {
      if (attachSelected) {
        // B-273: no directory probe — the daemon validates the target itself
        // and the cwd is meaningless inside the attached session.
        if (!createTerminalAt(navigate, machineId, { attachTmux: { id: attachSelected.id, name: attachSelected.name } })) {
          toast.error(t('newSession.machineOffline'));
          return;
        }
        onClose();
        return;
      }
      const guess = expandHomePath(trimmed, homeDir);
      // fs-list doubles as validation AND canonicalization: it answers with
      // the daemon-normalized absolute path, so a '~' the machine metadata
      // couldn't expand still reaches tmux as a real directory. An old daemon
      // ('unsupported') just skips both — the create path is unchanged there.
      const probe = await machineFsList(machineId, guess);
      let cwd = guess;
      if (probe.ok) {
        cwd = probe.path;
      } else if (probe.code !== 'unsupported') {
        toast.error(fsFailureText(t, probe));
        return;
      }
      // B-146: the machine can drop between the probe above and this call.
      // Closing the dialog unconditionally would leave the user with a
      // dismissed dialog, no terminal, and no explanation.
      if (!createTerminalAt(navigate, machineId, { cwd })) {
        toast.error(t('newSession.machineOffline'));
        return;
      }
      onClose();
    } catch (e: any) {
      toast.error(e?.message || t('errors.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('newTerminalModal.eyebrow')}</div>
        <div className="ns-title">{t('newTerminalModal.title')}</div>

        {showTips && (
          <div className="ns-tips" role="note">
            <div className="ns-tips-title">{t('newTerminalModal.tipsTitle')}</div>
            <ol className="ns-tips-list">
              <li>{t('newTerminalModal.tips1')}</li>
              <li>{t('newTerminalModal.tips2')}</li>
              <li>{t('newTerminalModal.tips3')}</li>
            </ol>
            <button
              className="ns-tips-dismiss"
              onClick={() => setDismissedHints({ ...(dismissedHints ?? {}), [TMUX_TIPS_HINT_KEY]: Date.now() })}
            >
              {t('newTerminalModal.tipsDismiss')}
            </button>
          </div>
        )}

        {online.length === 0 ? (
          <div className="ns-empty">{t('machine.noMachines')}</div>
        ) : (
          <>
            <label className="ns-label">{t('newSession.machine')}</label>
            <select
              className="ns-select"
              value={machineId}
              onChange={(e) => {
                setMachineId(e.target.value);
                setBrowsing(false); // the open listing belongs to the old machine
              }}
            >
              {online.map((m) => (
                <option key={m.id} value={m.id}>
                  {machineLabel(m)}
                </option>
              ))}
            </select>

            {!attachSupported && intent === 'attach' && (
              <div className="ns-hint">{t('newTerminalModal.attachNeedsCli')}</div>
            )}
            {attachSectionVisible(attachSupported) && (
              <>
                <label className="ns-label">{t('newTerminalModal.attachSection')}</label>
                {loadingSessions && sessions.length === 0 ? (
                  <div className="ns-hint">{t('newTerminalModal.attachLoading')}</div>
                ) : sessions.length === 0 ? (
                  <div className="ns-hint">{t('newTerminalModal.attachEmpty')}</div>
                ) : (
                  <div className="ns-sessions" role="listbox" aria-label={t('newTerminalModal.attachSection')}>
                    {sessions.map((s) => {
                      const on = attachId === s.id;
                      const age = formatSessionAge(s.activityAt ?? s.createdAt, Date.now());
                      return (
                        <div
                          key={s.id}
                          className={`ns-session${on ? ' is-on' : ''}`}
                          role="option"
                          aria-selected={on}
                          tabIndex={0}
                          onClick={() => setAttachId((cur) => toggleAttachSelection(cur, s.id))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAttachId((cur) => toggleAttachSelection(cur, s.id)); }
                          }}
                        >
                          <span className="ns-session-name mono">{s.name}</span>
                          <span className="ns-session-meta mono">
                            {s.windows === 1 ? t('newTerminalModal.attachWindow') : t('newTerminalModal.attachWindows', { count: s.windows })}
                            {s.attached ? ` · ${t('newTerminalModal.attachAttached')}` : ''}
                            {age ? ` · ${age}` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <label className="ns-label">{t('newSession.directory')}</label>

            {attachSelected ? (
              <div className="ns-hint">{t('newTerminalModal.attachIgnoresCwd')}</div>
            ) : (
            <>
            {list.length > 0 && (
              <div className="ns-presets">
                {list.map((p) => (
                  <span
                    key={p.id}
                    className={`ns-preset${editingId === p.id ? ' is-on' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setDirectory(p.path);
                      setEditingId(p.id);
                    }}
                  >
                    <span className="ns-preset-path">{p.label || p.path}</span>
                    <button
                      className="ns-preset-x"
                      title={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPresets(removePathPreset(list, p.id) as any);
                        if (editingId === p.id) setEditingId(null);
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void onCreate(); }
                }}
              />
              <button
                className={`ns-save${browsing ? ' is-saved' : ''}`}
                title={t('newTerminalModal.browse')}
                aria-pressed={browsing}
                disabled={!machineId}
                onClick={() => setBrowsing((v) => !v)}
              >
                <FolderOpen size={16} />
              </button>
              <button
                className={`ns-save${matchesEditing ? ' is-saved' : ''}`}
                title={editingId ? t('newSession.updatePreset') : t('newSession.savePreset')}
                disabled={!trimmed}
                onClick={savePreset}
              >
                {matchesEditing ? <Check size={16} /> : <Bookmark size={16} />}
              </button>
            </div>

            {browsing && (
              <div className="ns-browse">
                {/* Remounts per open (and per machine, via the key) so the
                    listing always starts from the path currently typed. */}
                <FsBrowser
                  key={`${machineId}:${browsing}`}
                  machineId={machineId}
                  initialPath={trimmed || '~'}
                  onPickDir={(p) => {
                    setDirectory(p);
                    setEditingId(null);
                    setBrowsing(false);
                  }}
                />
              </div>
            )}

            <div className="ns-hint">{t('newTerminalModal.startupHint')}</div>
            </>
            )}
          </>
        )}

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!canCreate} onClick={onCreate}>
            {t(primaryLabelKey(!!attachSelected))}
          </Button>
        </div>
      </div>
    </div>
  );
}
