import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Pencil, Play, Terminal, ChevronRight, History } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import {
  EmptyState,
  Button,
  Input,
  ItemList,
  ItemGroup,
  Item,
  Badge,
  StatusDot,
  Spinner,
} from '@/ui';
import { Modal } from '@/modal';
import { useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { storage, useMachine, useAllSessions, useLocalSetting, useSetting } from '@/sync/storage';
import { isHiddenSession } from '@/assistant/assistantSession';
import { sync } from '@/sync/sync';
import {
  machineStopDaemon,
  machineDelete,
  machineUpdateMetadata,
  machineSpawnNewSession,
} from '@/sync/ops';
import { isMachineOnline } from '@/utils/machineUtils';
import { useImeGuard } from '@/utils/ime';
import { ImportClaudeHistoryModal } from '@/screens/sessions/ImportClaudeHistoryModal';
import { claudeHistorySupported } from '@/sync/closedTerminals';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { getSessionName, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import '@/screens/settings/settings.css';
import { cliUpdateInstallCommand, hasValidCliUpdatePolicy, machineCliUpdateNotice } from '@/app/cliUpdatePolicy';
import { claudeAuthTone, isClaudeAuthStale, isKnownClaudeAuthDiagnosis, readClaudeAuth } from '@/sync/claudeAuth';
import { machineClaudeAuthProbe, machineClaudeAuthRepair, machineClaudeAuthSetStore, type ClaudeAuthRpcResult } from '@/sync/ops';

export function MachineScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const machine = useMachine(id ?? '');
  const allSessions = useAllSessions();
  const defaultAgent = normalizeAgentKey(useSetting('newSessionAgent'));
  const agentDefaultOverrides = useSetting('agentDefaultOverrides');
  const reviewFirst = useLocalSetting('newSessionReviewFirst');
  const permissionMode = resolveNewSessionPermissionMode(agentDefaultOverrides, defaultAgent, reviewFirst);

  const [pathInput, setPathInput] = useState('');
  const ime = useImeGuard();
  const [spawning, setSpawning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showImportClaude, setShowImportClaude] = useState(false);

  const online = machine ? isMachineOnline(machine) : false;
  const name = machine?.metadata?.displayName || machine?.metadata?.host || id || '';
  const homeDir = machine?.metadata?.homeDir;

  const machineSessions = useMemo(
    () =>
      allSessions
        // B-091/B-105: keep hidden sessions (assistant meta-session, terminal
        // mirrors) out of the machine's recent-sessions list too.
        .filter((s) => !isHiddenSession(s))
        .filter((s) => s.metadata?.machineId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [allSessions, id],
  );

  if (!machine) {
    return (
      <EmptyState
        title={t('machine.machineGroup')}
        description={id}
        actions={<Button onClick={() => navigate('/')}>{t('machine.back')}</Button>}
      />
    );
  }

  async function rename() {
    if (!machine) return;
    const next = await Modal.prompt(t('common.rename'), undefined, {
      defaultValue: machine.metadata?.displayName ?? machine.metadata?.host ?? '',
      confirmText: t('common.save'),
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!machine.metadata) return;
    setRenaming(true);
    try {
      await machineUpdateMetadata(
        machine.id,
        { ...machine.metadata, displayName: trimmed || undefined },
        machine.metadataVersion,
      );
      await sync.refreshMachines();
      toast.success(t('common.success'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setRenaming(false);
    }
  }

  async function spawn() {
    if (!machine) return;
    const raw = pathInput.trim();
    if (!raw) return;
    setSpawning(true);
    try {
      const directory = resolveAbsolutePath(raw, homeDir);
      let result = await machineSpawnNewSession({ machineId: machine.id, directory, agent: defaultAgent, permissionMode });
      if (result.type === 'requestToApproveDirectoryCreation') {
        const ok = await Modal.confirm(result.directory, undefined, {
          confirmText: t('common.create'),
        });
        if (!ok) {
          setSpawning(false);
          return;
        }
        result = await machineSpawnNewSession({
          machineId: machine.id,
          directory,
          agent: defaultAgent,
          permissionMode,
          approvedNewDirectoryCreation: true,
        });
      }
      if (result.type === 'success') {
        storage.getState().updateSessionPermissionMode(result.sessionId, permissionMode);
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
    const ok = await Modal.confirm(t('machine.stopDaemon'), undefined, {
      confirmText: t('machine.stopDaemon'),
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const res = await machineStopDaemon(machine.id);
      toast.success(res.message || (t('common.success')));
      await sync.refreshMachines();
    } catch (e: any) {
      toast.error(e?.message || (t('common.error')));
    } finally {
      setStopping(false);
    }
  }

  async function del() {
    if (!machine) return;
    const ok = await Modal.confirm(
      t('machine.deleteConfirmTitle'),
      t('machine.deleteConfirmMessage'),
      { confirmText: t('machine.delete'), destructive: true },
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await machineDelete(machine.id);
      if (res.success) {
        navigate('/settings/diagnostics');
      } else {
        toast.error(res.message || (t('machine.deleteFailed')));
      }
    } catch {
      toast.error(t('machine.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  const cli = machine.metadata?.cliAvailability;
  const daemon = machine.daemonState;
  // B-276: daemon-context Claude auth preflight (trust-gated on daemonPid).
  const claudeAuth = readClaudeAuth(machine);
  const claudeAuthMachineId = machine.id;
  const [claudeAuthBusy, setClaudeAuthBusy] = useState<null | 'probe' | 'repair' | 'store'>(null);
  const applyClaudeAuthResult = (result: ClaudeAuthRpcResult, successKey?: 'machine.claudeAuth.probed' | 'machine.claudeAuth.repaired' | 'machine.claudeAuth.storeSaved') => {
    if (!result.ok) {
      toast.error(result.unsupported ? t('machine.claudeAuth.unsupported') : `${t('machine.claudeAuth.failed')}: ${result.error}`);
      return;
    }
    if (successKey) toast.success(t(successKey));
  };
  async function claudeAuthProbe() {
    setClaudeAuthBusy('probe');
    try { applyClaudeAuthResult(await machineClaudeAuthProbe(claudeAuthMachineId), 'machine.claudeAuth.probed'); } finally { setClaudeAuthBusy(null); }
  }
  async function claudeAuthRepair() {
    const ok = await Modal.confirm(t('machine.claudeAuth.repairTitle'), t('machine.claudeAuth.repairMessage'), { confirmText: t('machine.claudeAuth.repairConfirm'), destructive: true });
    if (!ok) return;
    setClaudeAuthBusy('repair');
    try { applyClaudeAuthResult(await machineClaudeAuthRepair(claudeAuthMachineId, 'delete-empty-keychain-item'), 'machine.claudeAuth.repaired'); } finally { setClaudeAuthBusy(null); }
  }
  async function claudeAuthSetStore(store: 'auto' | 'file') {
    if (store === 'file') {
      const ok = await Modal.confirm(t('machine.claudeAuth.storeFileTitle'), t('machine.claudeAuth.storeFileMessage'), { confirmText: t('common.ok') });
      if (!ok) return;
    }
    setClaudeAuthBusy('store');
    try { applyClaudeAuthResult(await machineClaudeAuthSetStore(claudeAuthMachineId, store), 'machine.claudeAuth.storeSaved'); } finally { setClaudeAuthBusy(null); }
  }
  const cliUpdate = machineCliUpdateNotice(machine);
  const cliUpdateState = daemon?.cliUpdate;
  const cliUpdatePolicyKnown = hasValidCliUpdatePolicy(machine);
  // B-321: a new CLI is installed but refused to run, so the daemon is still on
  // the old code. Surfacing it is the whole point — this used to be a debug log
  // on a machine nobody was looking at. daemonState is untyped on the web, so
  // read it defensively rather than trusting the shape.
  const rawHold = (cliUpdateState as { handoverHold?: unknown } | undefined)?.handoverHold;
  const handoverHold = rawHold && typeof rawHold === 'object' && typeof (rawHold as { reason?: unknown }).reason === 'string'
    ? (rawHold as { reason: string })
    : null;

  async function copyUpdateCommand() {
    const command = cliUpdate ? cliUpdateInstallCommand(cliUpdate.targetVersion) : null;
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t('cliUpdate.copied'));
    } catch {
      toast.error(t('cliUpdate.copyFailed'));
    }
  }

  return (
    <div className="set-scroll" style={{ height: '100dvh' }}>
      <div className="set-page">
        <div className="set-header">
          <BackButton />
          <div className="set-header__titles">
            <span className="set-header__title">{name}</span>
            <span className="set-header__subtitle">{machine.metadata?.host}</span>
          </div>
          <div className="set-header__right">
            {claudeAuth && (
              <Badge tone={claudeAuthTone(claudeAuth)}>
                {claudeAuth.status === 'ok'
                  ? `Claude · ${claudeAuth.subscriptionType ?? claudeAuth.authMethod ?? 'ok'}`
                  : claudeAuth.status === 'unknown'
                    ? `Claude · ${claudeAuth.authMethod ?? t('machine.claudeAuth.unknown')}`
                    : t(`machine.claudeAuth.status.${claudeAuth.status}` as 'machine.claudeAuth.status.not-logged-in')}
              </Badge>
            )}
            <StatusDot status={online ? 'connected' : 'offline'} pulse={online} />
            <button type="button" className="set-header__back" onClick={rename} disabled={renaming} aria-busy={renaming} aria-label={t('common.rename')}>
              {renaming ? <Spinner size={14} /> : <Pencil size={16} />}
            </button>
          </div>
        </div>

        <ItemList>
          {online ? (
            <ItemGroup
              title={t('machine.launchNewSessionInDirectory')}
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
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={(e) => {
                      // IME guard: committing a CJK composition must not spawn.
                      if (ime.isGuarded(e)) return;
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
                  {t('newSession.startSession')}
                </Button>
              </div>
              {claudeHistorySupported(machine.daemonState) && (
                <Item
                  title={t('machine.importClaudeHistory')}
                  subtitle={t('machine.importClaudeHistorySubtitle')}
                  left={<History size={16} />}
                  onClick={() => setShowImportClaude(true)}
                  right={<ChevronRight size={16} />}
                />
              )}
            </ItemGroup>
          ) : (
            <ItemGroup>
              <Item title={t('machine.offlineUnableToSpawn')} />
              <div className="set-note" style={{ padding: '0 var(--sp-3) var(--sp-3)', whiteSpace: 'pre-line' }}>
                {t('cliUpdate.offlineHelp')}
              </div>
            </ItemGroup>
          )}

          <ItemGroup title={t('machine.daemon')}>
            <Item
              title={t('machine.status')}
              right={
                <Badge tone={online ? 'live' : 'muted'}>
                  {machine.metadata?.daemonLastKnownStatus ?? (online ? t('diagnostics.online') : t('diagnostics.offline'))}
                </Badge>
              }
            />
            {daemon?.pid != null && <Item title={t('machine.lastKnownPid')} detail={String(daemon.pid)} />}
            {daemon?.httpPort != null && (
              <Item title={t('machine.lastKnownHttpPort')} detail={String(daemon.httpPort)} />
            )}
            {daemon?.startTime && (
              <Item title={t('machine.startedAt')} detail={new Date(daemon.startTime).toLocaleString()} />
            )}
            {daemon?.startedWithCliVersion && (
              <Item title={t('machine.cliVersion')} detail={String(daemon.startedWithCliVersion)} />
            )}
            {cliUpdateState?.recommendedVersion && (
              <Item title={t('cliUpdate.recommended')} detail={String(cliUpdateState.recommendedVersion)} />
            )}
            {cliUpdateState?.minimumVersion && (
              <Item title={t('cliUpdate.minimum')} detail={String(cliUpdateState.minimumVersion)} />
            )}
            {cliUpdatePolicyKnown && (
              <Item
                title={t('cliUpdate.status')}
                right={
                  <Badge tone={cliUpdate?.severity === 'required' ? 'err' : cliUpdate ? 'warn' : 'live'}>
                    {cliUpdate?.severity === 'required'
                      ? t('cliUpdate.required')
                      : cliUpdate
                        ? t('cliUpdate.available')
                        : t('cliUpdate.current')}
                  </Badge>
                }
              />
            )}
            {handoverHold && (
              <Item
                title={t('cliUpdate.handoverHeld')}
                detail={`${String(handoverHold.reason)} · ${t('cliUpdate.handoverHeldHelp')}`}
                right={<Badge tone="err">{t('cliUpdate.handoverHeldBadge')}</Badge>}
              />
            )}
            {cliUpdate && (
              <Item
                title={t('cliUpdate.copyCommand')}
                subtitle={cliUpdateInstallCommand(cliUpdate.targetVersion) ?? undefined}
                onClick={() => void copyUpdateCommand()}
                right={<ChevronRight size={16} />}
              />
            )}
            <Item title={t('machine.daemonStateVersion')} detail={String(machine.daemonStateVersion)} />
            {online && (
              <Item title={t('machine.stopDaemon')} destructive onClick={stopDaemon} loading={stopping} right={<ChevronRight size={16} />} />
            )}
          </ItemGroup>

          {claudeAuth && (
            <ItemGroup
              title={t('machine.claudeAuth.title')}
              footer={[
                `${t('machine.lastDetected')}: ${new Date(claudeAuth.checkedAt).toLocaleString()}${isClaudeAuthStale(claudeAuth) ? ` · ${t('machine.claudeAuth.stale')}` : ''}`,
                claudeAuth.detail ?? '',
              ].filter(Boolean).join('\n')}
            >
              <Item
                title={t('machine.claudeAuth.statusLabel')}
                right={
                  <Badge tone={claudeAuthTone(claudeAuth)}>
                    {claudeAuth.status === 'unknown'
                      ? (claudeAuth.authMethod ?? t('machine.claudeAuth.unknown'))
                      : t(`machine.claudeAuth.status.${claudeAuth.status}` as 'machine.claudeAuth.status.ok')}
                  </Badge>
                }
                detail={claudeAuth.status === 'ok' ? [claudeAuth.authMethod, claudeAuth.subscriptionType].filter(Boolean).join(' · ') : undefined}
              />
              {claudeAuth.diagnosis && (
                <Item
                  title={t('machine.claudeAuth.diagnosis')}
                  detail={isKnownClaudeAuthDiagnosis(claudeAuth.diagnosis)
                    ? t(`machine.claudeAuth.diagnosisText.${claudeAuth.diagnosis}` as 'machine.claudeAuth.diagnosisText.no-credentials')
                    : claudeAuth.detail ?? claudeAuth.diagnosis}
                />
              )}
              <Item title={t('machine.claudeAuth.lineage')} detail={`${claudeAuth.context.lineage} · ${claudeAuth.context.platform}`} />
              <Item
                title={t('machine.claudeAuth.store')}
                detail={t(`machine.claudeAuth.storeValue.${claudeAuth.context.credentialStore}` as 'machine.claudeAuth.storeValue.auto')}
                right={claudeAuth.context.platform === 'darwin' && online ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={claudeAuthBusy === 'store'}
                    onClick={() => void claudeAuthSetStore(claudeAuth.context.credentialStore === 'file' ? 'auto' : 'file')}
                  >
                    {claudeAuth.context.credentialStore === 'file' ? t('machine.claudeAuth.storeUseAuto') : t('machine.claudeAuth.storeUseFile')}
                  </Button>
                ) : undefined}
              />
              {online && (
                <Item title={t('machine.claudeAuth.probe')} onClick={() => void claudeAuthProbe()} loading={claudeAuthBusy === 'probe'} right={<ChevronRight size={16} />} />
              )}
              {online && claudeAuth.repairable === 'delete-empty-keychain-item' && (
                <Item title={t('machine.claudeAuth.repair')} destructive onClick={() => void claudeAuthRepair()} loading={claudeAuthBusy === 'repair'} right={<ChevronRight size={16} />} />
              )}
            </ItemGroup>
          )}

          {cli && (
            <ItemGroup
              title={t('machine.cliAvailability')}
              footer={`${t('machine.lastDetected')}: ${new Date(cli.detectedAt).toLocaleString()}`}
            >
              {([
                'claude', 'codex', 'gemini', 'openclaw',
                // Only daemons with the pi runner report this field; older ones
                // cannot spawn pi, so showing "not found" there would mislead.
                ...(cli.pi !== undefined ? ['pi' as const] : []),
              ] as const).map((tool) => (
                <Item
                  key={tool}
                  title={tool}
                  right={
                    <Badge tone={cli[tool] ? 'live' : 'muted'}>
                      {cli[tool] ? t('machine.cliInstalled') : t('machine.cliNotFound')}
                    </Badge>
                  }
                />
              ))}
            </ItemGroup>
          )}

          {machineSessions.length > 0 && (
            <ItemGroup title={t('machine.activeSessions', { count: machineSessions.length })}>
              {machineSessions.map((s) => (
                <Item
                  key={s.id}
                  title={getSessionName(s) || (t('machine.untitledSession'))}
                  detail={s.metadata?.path ? formatPathRelativeToHome(s.metadata.path, s.metadata.homeDir) : undefined}
                  left={<Terminal size={16} />}
                  right={<ChevronRight size={16} />}
                  onClick={() => navigate(`/session/${s.id}`)}
                />
              ))}
            </ItemGroup>
          )}

          <ItemGroup title={t('machine.machineGroup')}>
            <Item title={t('machine.host')} detail={machine.metadata?.host} />
            <Item title={t('machine.machineId')} detail={machine.id} />
            {machine.metadata?.username && <Item title={t('machine.username')} detail={machine.metadata.username} />}
            {machine.metadata?.homeDir && <Item title={t('machine.homeDirectory')} detail={machine.metadata.homeDir} />}
            <Item title={t('machine.platform')} detail={machine.metadata?.platform} />
            {machine.metadata?.arch && <Item title={t('machine.architecture')} detail={machine.metadata.arch} />}
            <Item
              title={t('machine.lastSeen')}
              detail={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : (t('machine.never'))}
            />
            <Item title={t('machine.metadataVersion')} detail={String(machine.metadataVersion)} />
          </ItemGroup>

          <ItemGroup title={t('machine.dangerZone')} footer={t('machine.deleteFooter')}>
            <Item title={t('machine.delete')} destructive onClick={del} loading={deleting} />
          </ItemGroup>
        </ItemList>
      </div>
      {showImportClaude && <ImportClaudeHistoryModal initialMachineId={machine.id} onClose={() => setShowImportClaude(false)} />}
    </div>
  );
}
