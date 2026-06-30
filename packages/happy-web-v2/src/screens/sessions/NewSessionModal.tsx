import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineSpawnNewSession } from '@/sync/ops';
import { Button, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import './newsession.css';

const AGENTS = ['claude', 'codex', 'gemini', 'openclaw'] as const;

function machineLabel(m: any): string {
  return m?.metadata?.displayName || m?.metadata?.host || m?.id?.slice(0, 8) || 'machine';
}

export function NewSessionModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const [recentPaths] = useSettingMutable('recentMachinePaths');

  const [machineId, setMachineId] = useState(online[0]?.id ?? '');
  const [directory, setDirectory] = useState((recentPaths as string[] | undefined)?.[0] ?? '');
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>('claude');
  const [busy, setBusy] = useState(false);

  const canCreate = !!machineId && directory.trim().length > 0 && !busy;

  async function spawn(approve = false) {
    const res = await machineSpawnNewSession({
      machineId,
      directory: directory.trim(),
      agent,
      approvedNewDirectoryCreation: approve,
    });
    if (res.type === 'requestToApproveDirectoryCreation') {
      const ok = await Modal.confirm(
        t('newSession.createDirTitle' as any),
        t('newSession.createDirMessage' as any, { directory: res.directory } as any),
        { confirmText: t('common.create' as any) },
      );
      if (ok) return spawn(true);
      return null;
    }
    return res.sessionId;
  }

  async function onCreate() {
    if (!canCreate) return;
    setBusy(true);
    try {
      const sessionId = await spawn(false);
      if (sessionId) {
        onClose();
        navigate(`/session/${sessionId}`);
      }
    } catch (e: any) {
      toast.error(e?.message || t('errors.networkError' as any));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('newSessionModal.eyebrow' as any)}</div>
        <div className="ns-title">{t('newSessionModal.chatTitle' as any)}</div>

        {online.length === 0 ? (
          <div className="ns-empty">{t('machine.noMachines' as any)}</div>
        ) : (
          <>
            <label className="ns-label">{t('newSession.machine' as any)}</label>
            <select className="ns-select" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {online.map((m) => (
                <option key={m.id} value={m.id}>
                  {machineLabel(m)}
                </option>
              ))}
            </select>

            <label className="ns-label">{t('newSession.directory' as any)}</label>
            <input
              className="ns-input"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="~/code/project"
              autoFocus
            />

            <label className="ns-label">{t('newSession.agent' as any)}</label>
            <div className="ns-agents">
              {AGENTS.map((a) => (
                <button
                  key={a}
                  className={`ns-agent${agent === a ? ' is-on' : ''}`}
                  onClick={() => setAgent(a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel' as any)}
          </Button>
          <Button variant="primary" loading={busy} disabled={!canCreate} onClick={onCreate}>
            {t('common.create' as any)}
          </Button>
        </div>
      </div>
    </div>
  );
}
