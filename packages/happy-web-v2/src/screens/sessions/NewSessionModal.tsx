import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, Check, X } from 'lucide-react';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineSpawnNewSession } from '@/sync/ops';
import { Button, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import './newsession.css';

const AGENTS = ['claude', 'codex', 'gemini', 'openclaw'] as const;

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

export function NewSessionModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();
  const machines = useAllMachines({ includeOffline: true });
  const online = useMemo(() => machines.filter(isMachineOnline), [machines]);
  const [presets, setPresets] = useSettingMutable('sessionPathPresets');
  const list = (presets as PathPreset[] | undefined) ?? [];

  const [machineId, setMachineId] = useState(online[0]?.id ?? '');
  const [directory, setDirectory] = useState(list[0]?.path ?? '');
  const [editingId, setEditingId] = useState<string | null>(list[0]?.id ?? null);
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>('claude');
  const [busy, setBusy] = useState(false);

  const canCreate = !!machineId && directory.trim().length > 0 && !busy;
  const trimmed = directory.trim();

  // The daemon's spawn doesn't expand a leading ~, so resolve it here using the
  // selected machine's reported home dir. Avoids a bogus "create directory ~/…"
  // prompt for paths that actually exist.
  const homeDir = (online.find((m) => m.id === machineId) as any)?.metadata?.homeDir as string | undefined;
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
    const res = await machineSpawnNewSession({
      machineId,
      directory: resolveDir(trimmed),
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
                      title={t('common.delete' as any)}
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
                title={editingId ? t('newSession.updatePreset' as any) : t('newSession.savePreset' as any)}
                disabled={!trimmed}
                onClick={savePreset}
              >
                {matchesEditing ? <Check size={16} /> : <Bookmark size={16} />}
              </button>
            </div>

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
