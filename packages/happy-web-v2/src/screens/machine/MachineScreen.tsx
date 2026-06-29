import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, Pencil, Play, Terminal, ChevronRight } from 'lucide-react';
import {
  EmptyState,
  Button,
  Input,
  ItemList,
  ItemGroup,
  Item,
  Badge,
  StatusDot,
} from '@/ui';
import { Modal } from '@/modal';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useMachine, useAllSessions } from '@/sync/storage';
import { sync } from '@/sync/sync';
import {
  machineStopDaemon,
  machineDelete,
  machineUpdateMetadata,
  machineSpawnNewSession,
} from '@/sync/ops';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { getSessionName, formatPathRelativeToHome } from '@/utils/sessionUtils';
import '@/screens/settings/settings.css';

export function MachineScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const machine = useMachine(id ?? '');
  const allSessions = useAllSessions();

  const [pathInput, setPathInput] = useState('');
  const [spawning, setSpawning] = useState(false);
  const [stopping, setStopping] = useState(false);

  const online = machine ? isMachineOnline(machine) : false;
  const name = machine?.metadata?.displayName || machine?.metadata?.host || id || '';
  const homeDir = machine?.metadata?.homeDir;

  const machineSessions = useMemo(
    () =>
      allSessions
        .filter((s) => s.metadata?.machineId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [allSessions, id],
  );

  if (!machine) {
    return (
      <EmptyState
        title={t('machine.machineGroup' as any) as string}
        description={id}
        actions={<Button onClick={() => navigate('/')}>{t('machine.back' as any)}</Button>}
      />
    );
  }

  async function rename() {
    if (!machine) return;
    const next = await Modal.prompt(t('common.rename' as any) as string, undefined, {
      defaultValue: machine.metadata?.displayName ?? machine.metadata?.host ?? '',
      confirmText: t('common.save' as any) as string,
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!machine.metadata) return;
    try {
      await machineUpdateMetadata(
        machine.id,
        { ...machine.metadata, displayName: trimmed || undefined },
        machine.metadataVersion,
      );
      await sync.refreshMachines();
      toast.success(t('common.success' as any) as string);
    } catch {
      toast.error(t('common.error' as any) as string);
    }
  }

  async function spawn() {
    if (!machine) return;
    const raw = pathInput.trim();
    if (!raw) return;
    setSpawning(true);
    try {
      const directory = resolveAbsolutePath(raw, homeDir);
      let result = await machineSpawnNewSession({ machineId: machine.id, directory });
      if (result.type === 'requestToApproveDirectoryCreation') {
        const ok = await Modal.confirm(result.directory, undefined, {
          confirmText: t('common.create' as any) as string,
        });
        if (!ok) {
          setSpawning(false);
          return;
        }
        result = await machineSpawnNewSession({
          machineId: machine.id,
          directory,
          approvedNewDirectoryCreation: true,
        });
      }
      if (result.type === 'success') {
        setPathInput('');
        navigate(`/session/${result.sessionId}`);
      } else if (result.type === 'error') {
        toast.error(result.errorMessage);
      }
    } finally {
      setSpawning(false);
    }
  }

  async function stopDaemon() {
    if (!machine) return;
    const ok = await Modal.confirm(t('machine.stopDaemon' as any) as string, undefined, {
      confirmText: t('machine.stopDaemon' as any) as string,
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const res = await machineStopDaemon(machine.id);
      toast.success(res.message || (t('common.success' as any) as string));
      await sync.refreshMachines();
    } catch (e: any) {
      toast.error(e?.message || (t('common.error' as any) as string));
    } finally {
      setStopping(false);
    }
  }

  async function del() {
    if (!machine) return;
    const ok = await Modal.confirm(
      t('machine.deleteConfirmTitle' as any) as string,
      t('machine.deleteConfirmMessage' as any) as string,
      { confirmText: t('machine.delete' as any) as string, destructive: true },
    );
    if (!ok) return;
    const res = await machineDelete(machine.id);
    if (res.success) {
      navigate('/settings/diagnostics');
    } else {
      toast.error(res.message || (t('machine.deleteFailed' as any) as string));
    }
  }

  const cli = machine.metadata?.cliAvailability;
  const daemon = machine.daemonState;

  return (
    <div className="set-scroll" style={{ height: '100dvh' }}>
      <div className="set-page">
        <div className="set-header">
          <button type="button" className="set-header__back" onClick={() => navigate('/')} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <div className="set-header__titles">
            <span className="set-header__title">{name}</span>
            <span className="set-header__subtitle">{machine.metadata?.host}</span>
          </div>
          <div className="set-header__right">
            <StatusDot status={online ? 'connected' : 'offline'} pulse={online} />
            <button type="button" className="set-header__back" onClick={rename} aria-label={t('common.rename' as any) as string}>
              <Pencil size={16} />
            </button>
          </div>
        </div>

        <ItemList>
          {online ? (
            <ItemGroup
              title={t('machine.launchNewSessionInDirectory' as any) as string}
              footer={
                machine.metadata?.homeDir
                  ? formatPathRelativeToHome(machine.metadata.homeDir, machine.metadata.homeDir)
                  : undefined
              }
            >
              <div style={{ display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-3)' }}>
                <div style={{ flex: 1 }}>
                  <Input
                    placeholder="~/code/project"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') spawn();
                    }}
                  />
                </div>
                <Button
                  variant="primary"
                  loading={spawning}
                  disabled={pathInput.trim().length === 0}
                  onClick={spawn}
                  leftIcon={<Play size={14} />}
                >
                  {t('newSession.startSession' as any)}
                </Button>
              </div>
            </ItemGroup>
          ) : (
            <ItemGroup>
              <Item title={t('machine.offlineUnableToSpawn' as any)} />
              <div className="set-note" style={{ padding: '0 var(--sp-3) var(--sp-3)', whiteSpace: 'pre-line' }}>
                {t('machine.offlineHelp' as any)}
              </div>
            </ItemGroup>
          )}

          <ItemGroup title={t('machine.daemon' as any) as string}>
            <Item
              title={t('machine.status' as any)}
              right={
                <Badge tone={online ? 'live' : 'muted'}>
                  {machine.metadata?.daemonLastKnownStatus ?? (online ? t('diagnostics.online' as any) : t('diagnostics.offline' as any))}
                </Badge>
              }
            />
            {daemon?.pid != null && <Item title={t('machine.lastKnownPid' as any)} detail={String(daemon.pid)} />}
            {daemon?.httpPort != null && (
              <Item title={t('machine.lastKnownHttpPort' as any)} detail={String(daemon.httpPort)} />
            )}
            {daemon?.startTime && (
              <Item title={t('machine.startedAt' as any)} detail={new Date(daemon.startTime).toLocaleString()} />
            )}
            {daemon?.startedWithCliVersion && (
              <Item title={t('machine.cliVersion' as any)} detail={String(daemon.startedWithCliVersion)} />
            )}
            <Item title={t('machine.daemonStateVersion' as any)} detail={String(machine.daemonStateVersion)} />
            {online && (
              <Item title={t('machine.stopDaemon' as any)} destructive onClick={stopDaemon} right={stopping ? undefined : <ChevronRight size={16} />} />
            )}
          </ItemGroup>

          {cli && (
            <ItemGroup
              title={t('machine.cliAvailability' as any) as string}
              footer={`${t('machine.lastDetected' as any)}: ${new Date(cli.detectedAt).toLocaleString()}`}
            >
              {(['claude', 'codex', 'gemini', 'openclaw'] as const).map((tool) => (
                <Item
                  key={tool}
                  title={tool}
                  right={
                    <Badge tone={cli[tool] ? 'live' : 'muted'}>
                      {cli[tool] ? t('machine.cliInstalled' as any) : t('machine.cliNotFound' as any)}
                    </Badge>
                  }
                />
              ))}
            </ItemGroup>
          )}

          {machineSessions.length > 0 && (
            <ItemGroup title={t('machine.activeSessions' as any, { count: machineSessions.length } as any) as string}>
              {machineSessions.map((s) => (
                <Item
                  key={s.id}
                  title={getSessionName(s) || (t('machine.untitledSession' as any) as string)}
                  detail={s.metadata?.path ? formatPathRelativeToHome(s.metadata.path, s.metadata.homeDir) : undefined}
                  left={<Terminal size={16} />}
                  right={<ChevronRight size={16} />}
                  onClick={() => navigate(`/session/${s.id}`)}
                />
              ))}
            </ItemGroup>
          )}

          <ItemGroup title={t('machine.machineGroup' as any) as string}>
            <Item title={t('machine.host' as any)} detail={machine.metadata?.host} />
            <Item title={t('machine.machineId' as any)} detail={machine.id} />
            {machine.metadata?.username && <Item title={t('machine.username' as any)} detail={machine.metadata.username} />}
            {machine.metadata?.homeDir && <Item title={t('machine.homeDirectory' as any)} detail={machine.metadata.homeDir} />}
            <Item title={t('machine.platform' as any)} detail={machine.metadata?.platform} />
            {machine.metadata?.arch && <Item title={t('machine.architecture' as any)} detail={machine.metadata.arch} />}
            <Item
              title={t('machine.lastSeen' as any)}
              detail={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : (t('machine.never' as any) as string)}
            />
            <Item title={t('machine.metadataVersion' as any)} detail={String(machine.metadataVersion)} />
          </ItemGroup>

          <ItemGroup title={t('machine.dangerZone' as any) as string} footer={t('machine.deleteFooter' as any) as string}>
            <Item title={t('machine.delete' as any)} destructive onClick={del} />
          </ItemGroup>
        </ItemList>
      </div>
    </div>
  );
}
