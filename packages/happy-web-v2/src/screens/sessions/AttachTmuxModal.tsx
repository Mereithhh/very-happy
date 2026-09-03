/**
 * AttachTmuxModal (B-281) — the dedicated "attach a tmux session" picker.
 *
 * Owner feedback on B-280: the dedicated entry should list the attachable
 * sessions DIRECTLY (click = attach), not open the new-terminal dialog. This
 * modal does exactly that: pick the machine (auto when only one is online),
 * see its non-vh tmux sessions immediately, click one to open a web terminal
 * attached to it (B-273 machinery: `createTerminalAt` with `attachTmux`).
 *
 * The directory dialog keeps its embedded section for the browse-first flow;
 * both end in the same create path.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline, machineLabel, pickDefaultMachineId } from '@/utils/machineUtils';
import { createTerminalAt } from '@/app/newTerminal';
import { machineListTmuxSessions } from '@/sync/ops';
import { tmuxSessionsSupported } from '@/sync/closedTerminals';
import { Button, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { NoMachinesNotice } from './NoMachinesNotice';
import { formatSessionAge, type UserTmuxSession } from './newTerminalAttach';
import './newsession.css';

export function AttachTmuxModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);

  const [machineId, setMachineId] = useState(() => pickDefaultMachineId(online.map((m) => m.id)));
  const [sessions, setSessions] = useState<UserTmuxSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Same cold-start re-derive as NewTerminalModal (B-146).
  const onlineIds = useMemo(() => online.map((m) => m.id), [online]);
  useEffect(() => {
    const next = pickDefaultMachineId(onlineIds, machineId);
    if (next !== machineId) setMachineId(next);
  }, [onlineIds, machineId]);

  const machine = online.find((m) => m.id === machineId);
  const supported = !!machine && tmuxSessionsSupported((machine as any).daemonState);

  useEffect(() => {
    setSessions([]);
    if (!machineId || !supported) return;
    let cancelled = false;
    setLoading(true);
    machineListTmuxSessions(machineId)
      .then((list) => { if (!cancelled) setSessions(list); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [machineId, supported]);

  function attach(s: UserTmuxSession) {
    if (busy) return;
    setBusy(true);
    // The machine can drop between the listing and the click (B-146 rule).
    if (!createTerminalAt(navigate, machineId, { attachTmux: { id: s.id, name: s.name } })) {
      toast.error(t('newSession.machineOffline'));
      setBusy(false);
      return;
    }
    onClose();
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('attachTmuxModal.eyebrow')}</div>
        <div className="ns-title">{t('attachTmuxModal.title')}</div>

        {online.length === 0 ? (
          <NoMachinesNotice onClose={onClose} />
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
              <div className="ns-hint">{t('newTerminalModal.attachNeedsCli')}</div>
            ) : loading && sessions.length === 0 ? (
              <div className="ns-hint">{t('newTerminalModal.attachLoading')}</div>
            ) : sessions.length === 0 ? (
              <div className="ns-hint">{t('newTerminalModal.attachEmpty')}</div>
            ) : (
              <div className="ns-sessions" role="listbox" aria-label={t('attachTmuxModal.title')}>
                {sessions.map((s) => {
                  const age = formatSessionAge(s.activityAt ?? s.createdAt, Date.now());
                  return (
                    <div
                      key={s.id}
                      className="ns-session"
                      role="option"
                      aria-selected={false}
                      tabIndex={0}
                      aria-disabled={busy}
                      onClick={() => attach(s)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); attach(s); }
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

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </div>
    </div>
  );
}
