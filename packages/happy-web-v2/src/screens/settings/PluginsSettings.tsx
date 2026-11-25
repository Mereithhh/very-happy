/**
 * B-974d: Settings → Plugins (DESIGN B-973 §3.2–§3.4, §5.6, §5.7, §7).
 *
 * - /settings/plugins                     list: waiting for approval, installed
 * - /settings/plugins/:installId          detail: grants (revoke), disable / enable,
 *                                         remove, mute, recent activity
 * - /settings/plugins/:installId/review   approval: per-permission checkboxes with
 *                                         risk colour, sensitive items need a second
 *                                         confirmation, changed lines on an update
 *
 * Separate file on purpose: SettingsRoutes.tsx is a conflict hot-zone — it only
 * gains an import, three <Route> lines and one overview <Item>.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ChevronRight, ExternalLink, Puzzle } from 'lucide-react';
import * as Switch from '@radix-ui/react-switch';
import { SettingsPage as Page, SettingsHeader as Header } from './SettingsLayout';
import { Badge, Button, Checkbox, Item, ItemGroup, ItemList, Spinner, StatusDot, toast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useMachine } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import {
  approvePluginInstall,
  disablePluginInstall,
  enablePluginInstall,
  getPluginAudit,
  getPluginInstall as fetchPluginDetail,
  isPluginsUnavailable,
  PluginsApiError,
  rejectPluginInstall,
  removePluginInstall,
  revokePluginGrants,
  setPluginMuted,
} from '@/sync/apiPlugins';
import { OWNER_LOGIN_REQUIRED } from '@/sync/apiAttention';
import { applyInstall, dropInstall, loadPluginInstalls, usePluginInstall, usePluginInstallMap, usePluginStore } from '@/sync/pluginStore';
import { PluginIcon } from '@/plugins/PluginIcon';
import { approvalGrants, canOpenPanel, initialGrants, installStatus, isSensitive, knownPermissions, needsReview, permissionRisk, toggleGrant, type PermissionRisk } from '@/plugins/pluginModel';
import { PLUGIN_INSTALL_STATES } from '@slopus/happy-wire';
import type { PluginAudit, PluginInstallView, PluginPermission } from '@/plugins/pluginTypes';
import type { PluginReviewDetail } from '@/sync/apiPlugins';
import { diffValueText, permissionTextKey, reviewPanelRows } from '@/plugins/pluginReview';
import { pluginPanelPath } from '@/plugins/pluginRoutes';
import './plugins.css';

type T = ReturnType<typeof useTranslation>['t'];

type KnownState = Exclude<(typeof PLUGIN_INSTALL_STATES)[number], 'removed'>;
const SHOWN_STATES: readonly string[] = PLUGIN_INSTALL_STATES.filter((s) => s !== 'removed');
function stateLabel(t: T, i: PluginInstallView): string {
  // An unknown (newer) state reads as disabled rather than a raw key.
  const s = (SHOWN_STATES.includes(i.state) ? i.state : 'disabled') as KnownState;
  return t(`plugins.state.${s}`);
}
function riskLabel(t: T, r: PermissionRisk): string {
  return t(`plugins.risk.${r}`);
}

function stateTone(i: PluginInstallView): 'live' | 'warn' | 'err' | 'muted' {
  switch (installStatus(i)) {
    case 'enabled':
      return 'live';
    case 'needs-review':
    case 'update-pending':
      return 'warn';
    case 'operator':
      return 'err';
    default:
      return 'muted';
  }
}

export function permTitle(t: T, p: PluginPermission): string {
  return t(`plugins.perm.${permissionTextKey(p)}.title`);
}
function permDesc(t: T, p: PluginPermission): string {
  return t(`plugins.perm.${permissionTextKey(p)}.desc`);
}

function riskTone(p: PluginPermission): 'muted' | 'warn' | 'err' {
  const r = permissionRisk(p);
  return r === 'sensitive' ? 'err' : r === 'medium' ? 'warn' : 'muted';
}

function errorCode(e: unknown): string {
  return e instanceof PluginsApiError ? e.code : e instanceof Error ? e.message : 'error';
}

function MachineName({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const m = useMachine(machineId);
  if (!m) return <>{t('plugins.unknownMachine')}</>;
  return (
    <>
      {machineLabel(m)}
      {!isMachineOnline(m) && <> · {t('plugins.machineOffline')}</>}
    </>
  );
}

function usePluginsLoaded(): 'loading' | 'ready' | 'unavailable' {
  const availability = usePluginStore((s) => s.availability);
  useEffect(() => {
    void loadPluginInstalls();
  }, []);
  return availability === 'unavailable' ? 'unavailable' : availability === 'available' ? 'ready' : 'loading';
}

// ─── list ─────────────────────────────────────────────────────────────────

export function PluginsSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const status = usePluginsLoaded();
  const map = usePluginInstallMap();
  const all = useMemo(() => Object.values(map).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [map]);
  const waiting = all.filter(needsReview);
  const rest = all.filter((i) => !needsReview(i));

  const row = (i: PluginInstallView, review: boolean) => (
    <Item
      key={i.id}
      title={i.name}
      subtitle={
        <>
          <MachineName machineId={i.machineId} /> · v{i.version}
        </>
      }
      left={<PluginIcon icon={i.icon} size={18} />}
      right={
        <span className="plg-row-right">
          {i.muted && <Badge dot={false}>{t('plugins.muted')}</Badge>}
          <Badge tone={stateTone(i)}>{stateLabel(t, i)}</Badge>
          <ChevronRight size={16} />
        </span>
      }
      onClick={() => navigate(review ? `/settings/plugins/${encodeURIComponent(i.id)}/review` : `/settings/plugins/${encodeURIComponent(i.id)}`)}
    />
  );

  return (
    <Page>
      <Header title={t('plugins.title')} />
      <ItemList>
        <p className="set-note plg-intro">
          {t('plugins.intro')} {t('plugins.webPanelsNote')}
        </p>
        {status === 'unavailable' && <p className="set-note">{t('plugins.unavailable')}</p>}
        {status === 'loading' && (
          <div className="plg-loading">
            <Spinner size={16} />
          </div>
        )}
        {status === 'ready' && (
          <>
            {waiting.length > 0 && (
              <ItemGroup settingId="plugins.review" title={t('plugins.reviewTitle')}>
                {waiting.map((i) => row(i, true))}
              </ItemGroup>
            )}
            <ItemGroup settingId="plugins.list" title={t('plugins.listTitle')}>
              {rest.length === 0 && waiting.length === 0 && <Item title={t('plugins.empty')} multiline />}
              {rest.map((i) => row(i, false))}
            </ItemGroup>
          </>
        )}
      </ItemList>
    </Page>
  );
}

// ─── detail ───────────────────────────────────────────────────────────────

function MuteSwitch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <Switch.Root className="set-switch vh-hit" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}>
      <Switch.Thumb className="set-switch__thumb" />
    </Switch.Root>
  );
}

function actorLabel(t: T, actor: string): string {
  if (actor === 'owner' || actor === 'machine' || actor === 'plugin' || actor === 'operator') return t(`plugins.detail.actor.${actor}`);
  return actor;
}

export function PluginDetailSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { installId = '' } = useParams();
  const status = usePluginsLoaded();
  const install = usePluginInstall(installId);
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState<PluginAudit | null>(null);

  useEffect(() => {
    if (!install) return;
    let live = true;
    getPluginAudit(install.id)
      .then((a) => live && setAudit(a))
      .catch(() => live && setAudit({ entries: [], sensitiveReads24h: 0 }));
    return () => {
      live = false;
    };
  }, [install?.id, install?.state, install?.grants.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(
    async (key: string, work: () => Promise<PluginInstallView | void>) => {
      setBusy(key);
      try {
        const next = await work();
        if (next) applyInstall(next);
      } catch (e) {
        toast.error(errorCode(e) === OWNER_LOGIN_REQUIRED ? t('plugins.review.loginRequired') : t('plugins.review.failed', { code: errorCode(e) }));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  if (status !== 'ready' || !install) {
    return (
      <Page>
        <Header title={t('plugins.title')} />
        <ItemList>
          {status === 'loading' ? (
            <div className="plg-loading">
              <Spinner size={16} />
            </div>
          ) : (
            <p className="set-note">{status === 'unavailable' ? t('plugins.unavailable') : t('plugins.review.notFound')}</p>
          )}
        </ItemList>
      </Page>
    );
  }

  const operator = install.state === 'disabled_by_operator';
  const enabled = install.state === 'enabled' || install.state === 'update_pending';
  const grants = knownPermissions(install.grants);
  const readsSensitive = grants.some(isSensitive);

  const revoke = async (p: PluginPermission) => {
    const ok = await Modal.confirm(t('plugins.detail.revokeConfirmTitle', { perm: permTitle(t, p) }), t('plugins.detail.revokeConfirmBody'), { confirmText: t('plugins.detail.revoke'), destructive: true });
    if (ok) await run(`revoke:${p}`, () => revokePluginGrants(install.id, [p]));
  };
  const disable = async () => {
    const ok = await Modal.confirm(t('plugins.detail.disableConfirmTitle', { name: install.name }), t('plugins.detail.disableSubtitle'), { confirmText: t('plugins.detail.disable'), destructive: true });
    if (ok) await run('disable', () => disablePluginInstall(install.id));
  };
  const remove = async () => {
    const ok = await Modal.confirm(t('plugins.detail.removeConfirmTitle', { name: install.name }), t('plugins.detail.removeSubtitle'), { confirmText: t('plugins.detail.remove'), destructive: true });
    if (!ok) return;
    await run('remove', async () => {
      await removePluginInstall(install.id);
      dropInstall(install.id);
      navigate('/settings/plugins', { replace: true });
    });
  };

  return (
    <Page>
      <Header title={install.name} subtitle={`v${install.version}`} />
      <ItemList>
        <div className="plg-head" data-setting-id="plugins.detail">
          <span className="plg-head__icon">
            <PluginIcon icon={install.icon} size={22} />
          </span>
          <span className="plg-head__text">
            <span className="plg-head__line">
              <Badge tone={stateTone(install)}>{stateLabel(t, install)}</Badge>
              {install.muted && <Badge dot={false}>{t('plugins.muted')}</Badge>}
            </span>
            <span className="plg-head__meta">
              <MachineName machineId={install.machineId} /> · <span className="plg-mono">{install.pluginId}</span>
            </span>
          </span>
        </div>
        {operator && (
          <p className="plg-alert" role="note">
            <AlertTriangle size={14} className="vh-icon-inline" /> {t('plugins.detail.operatorNote')}
            {install.stateReason ? ` ${install.stateReason}` : ''}
          </p>
        )}
        {needsReview(install) && (
          <ItemGroup>
            <Item
              title={t('plugins.detail.reviewCta')}
              subtitle={stateLabel(t, install)}
              left={<AlertTriangle size={18} />}
              right={<ChevronRight size={16} />}
              onClick={() => navigate(`/settings/plugins/${encodeURIComponent(install.id)}/review`)}
            />
          </ItemGroup>
        )}
        {install.panels.length > 0 && canOpenPanel(install, install.panels[0].id) && (
          <ItemGroup title={t('plugins.detail.openPanel')}>
            {install.panels.map((p) => (
              <Item key={p.id} title={p.title} left={<ExternalLink size={18} />} right={<ChevronRight size={16} />} onClick={() => navigate(pluginPanelPath(install.id, p.id))} />
            ))}
          </ItemGroup>
        )}
        <ItemGroup title={t('plugins.detail.grantsTitle')}>
          {grants.length === 0 && <Item title={t('plugins.detail.noGrants')} />}
          {grants.map((p) => (
            <Item
              key={p}
              title={
                <span className="plg-perm-title">
                  {permTitle(t, p)}
                  <Badge tone={riskTone(p)} dot={false}>
                    {riskLabel(t, permissionRisk(p))}
                  </Badge>
                </span>
              }
              subtitle={permDesc(t, p)}
              multiline
              right={
                <Button size="sm" variant="ghost" loading={busy === `revoke:${p}`} disabled={!!busy || operator} onClick={() => void revoke(p)}>
                  {t('plugins.detail.revoke')}
                </Button>
              }
            />
          ))}
        </ItemGroup>
        <ItemGroup title={t('plugins.detail.manageTitle')}>
          <Item
            title={t('plugins.detail.mute')}
            subtitle={t('plugins.detail.muteSubtitle')}
            multiline
            right={<MuteSwitch checked={!!install.muted} disabled={!!busy} label={t('plugins.detail.mute')} onChange={(v) => void run('mute', () => setPluginMuted(install.id, v))} />}
          />
          {!operator && install.state !== 'pending' && install.state !== 'rejected' && (
            <Item
              title={enabled ? t('plugins.detail.disable') : t('plugins.detail.enable')}
              subtitle={enabled ? t('plugins.detail.disableSubtitle') : undefined}
              multiline
              loading={busy === 'disable' || busy === 'enable'}
              disabled={!!busy}
              onClick={() => (enabled ? void disable() : void run('enable', () => enablePluginInstall(install.id)))}
            />
          )}
          <Item title={t('plugins.detail.remove')} subtitle={t('plugins.detail.removeSubtitle')} multiline destructive loading={busy === 'remove'} disabled={!!busy} onClick={() => void remove()} />
        </ItemGroup>
        <ItemGroup title={t('plugins.detail.auditTitle')} footer={readsSensitive && audit ? t('plugins.detail.sensitiveReads', { count: audit.sensitiveReads24h }) : undefined}>
          {!audit && (
            <div className="plg-loading">
              <Spinner size={14} />
            </div>
          )}
          {audit && audit.entries.length === 0 && <Item title={t('plugins.detail.auditEmpty')} />}
          {audit?.entries.map((e) => (
            <Item key={e.id} title={<span className="plg-mono">{e.action}</span>} subtitle={`${actorLabel(t, e.actor)} · ${new Date(e.at).toLocaleString()}${e.detail ? ` · ${e.detail}` : ''}`} multiline />
          ))}
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ─── review ───────────────────────────────────────────────────────────────

export function PluginReviewSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { installId = '' } = useParams();
  const [detail, setDetail] = useState<PluginReviewDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grants, setGrants] = useState<PluginPermission[]>([]);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await fetchPluginDetail(installId);
      setDetail(d);
      setGrants(initialGrants(d.review.manifest.permissions, d.install.state === 'update_pending' ? d.install.grants : []));
      applyInstall(d.install);
    } catch (e) {
      setLoadError(isPluginsUnavailable(e) ? 'unavailable' : e instanceof PluginsApiError && e.status === 404 ? 'not_found' : errorCode(e));
    }
  }, [installId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!detail) {
    return (
      <Page>
        <Header title={t('plugins.review.title')} />
        <ItemList>
          {!loadError && (
            <div className="plg-loading">
              <Spinner size={16} />
            </div>
          )}
          {loadError && (
            <p className="set-note" role="alert">
              {loadError === 'unavailable' ? t('plugins.unavailable') : loadError === 'not_found' ? t('plugins.review.notFound') : t('plugins.loadFailed', { code: loadError })}{' '}
              {loadError !== 'not_found' && loadError !== 'unavailable' && (
                <Button size="sm" variant="secondary" onClick={() => void load()}>
                  {t('plugins.retry')}
                </Button>
              )}
            </p>
          )}
        </ItemList>
      </Page>
    );
  }

  const { install, review } = detail;
  const m = review.manifest;
  const isUpdate = install.state === 'update_pending';
  const reviewable = needsReview(install);
  const diff = isUpdate ? install.pendingDiff : null;
  const panelRows = reviewPanelRows(m);

  const onToggle = async (p: PluginPermission, checked: boolean) => {
    if (checked && isSensitive(p) && !grants.includes(p)) {
      const ok = await Modal.confirm(t('plugins.review.sensitiveConfirmTitle'), t('plugins.review.sensitiveConfirmBody', { name: m.name, perm: permDesc(t, p) }), {
        confirmText: t('plugins.review.sensitiveConfirm'),
        destructive: true,
      });
      setGrants((g) => toggleGrant(g, p, true, ok));
      return;
    }
    setGrants((g) => toggleGrant(g, p, checked, false));
  };

  const approve = async () => {
    setBusy('approve');
    setNotice(null);
    try {
      const next = await approvePluginInstall(install.id, approvalGrants(m.permissions, grants), review.manifestHash);
      applyInstall(next);
      toast.success(t('plugins.review.approved'));
      navigate(`/settings/plugins/${encodeURIComponent(install.id)}`, { replace: true });
    } catch (e) {
      const code = errorCode(e);
      if (code === 'manifest_changed') {
        await load();
        setNotice(t('plugins.review.manifestChanged'));
      } else setNotice(code === OWNER_LOGIN_REQUIRED ? t('plugins.review.loginRequired') : t('plugins.review.failed', { code }));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    const ok = await Modal.confirm(t('plugins.review.rejectConfirmTitle'), t('plugins.review.rejectConfirmBody'), { confirmText: t('plugins.review.reject'), destructive: true });
    if (!ok) return;
    setBusy('reject');
    try {
      const next = await rejectPluginInstall(install.id);
      applyInstall(next);
      toast.success(t('plugins.review.rejected'));
      navigate('/settings/plugins', { replace: true });
    } catch (e) {
      setNotice(t('plugins.review.failed', { code: errorCode(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <Header title={isUpdate ? t('plugins.review.updateTitle') : t('plugins.review.title')} />
      <ItemList>
        <div className="plg-head" data-setting-id="plugins.review.head">
          <span className="plg-head__icon">
            <PluginIcon icon={m.icon} size={22} />
          </span>
          <span className="plg-head__text">
            <span className="plg-head__name">{m.name}</span>
            <span className="plg-head__meta">
              v{m.version} · <span className="plg-mono">{m.id}</span>
            </span>
            {m.description && <span className="plg-head__desc">{m.description}</span>}
          </span>
        </div>
        <ItemGroup>
          <Item
            title={t('plugins.review.publisher')}
            right={
              <span className="plg-row-right">
                <span>{m.publisher?.name ?? '—'}</span>
                <Badge tone="warn" dot={false}>
                  {t('plugins.review.unverified')}
                </Badge>
              </span>
            }
          />
          <Item
            title={t('plugins.review.machine')}
            right={
              <span className="plg-row-right">
                <MachineName machineId={install.machineId} />
              </span>
            }
          />
          <Item title={t('plugins.review.manifest')} right={<span className="plg-mono">{review.manifestHash.slice(0, 8) || '—'}</span>} />
          {review.submittedAt ? <Item title={t('plugins.review.submitted')} right={<span>{new Date(review.submittedAt).toLocaleString()}</span>} /> : null}
        </ItemGroup>

        {diff && (diff.changes.length > 0 || diff.addedPermissions.length > 0 || diff.removedPermissions.length > 0) && (
          <ItemGroup title={t('plugins.review.diffTitle')} footer={t('plugins.review.oldStaysNote')}>
            {knownPermissions(diff.addedPermissions).map((p) => (
              <Item key={`+${p}`} title={<span className="plg-diff plg-diff--add">+ {permTitle(t, p)}</span>} right={<Badge tone="warn" dot={false}>{t('plugins.review.diffNeedsApproval')}</Badge>} />
            ))}
            {knownPermissions(diff.removedPermissions).map((p) => (
              <Item key={`-${p}`} title={<span className="plg-diff plg-diff--del">− {permTitle(t, p)}</span>} />
            ))}
            {diff.changes.map((c, idx) => (
              <Item
                key={`${c.field}:${idx}`}
                title={<span className="plg-mono">{c.field}</span>}
                detail={
                  <span className="plg-diff-line">
                    <span className="plg-diff plg-diff--del">{diffValueText(c.before)}</span>
                    <span aria-hidden> → </span>
                    <span className="plg-diff plg-diff--add">{diffValueText(c.after)}</span>
                  </span>
                }
                multiline
                right={c.privileged ? <Badge tone="warn" dot={false}>{t('plugins.review.diffNeedsApproval')}</Badge> : undefined}
              />
            ))}
          </ItemGroup>
        )}

        <ItemGroup settingId="plugins.review.permissions" title={t('plugins.review.permissionsTitle')}>
          {m.permissions.length === 0 && <Item title={t('plugins.detail.noGrants')} />}
          {knownPermissions(m.permissions).map((p) => (
            <div key={p} className="plg-perm" data-risk={permissionRisk(p)}>
              <Checkbox checked={grants.includes(p)} disabled={!reviewable || !!busy} onCheckedChange={(v) => void onToggle(p, v)}>
                <span className="plg-perm__text">
                  <span className="plg-perm-title">
                    {permTitle(t, p)}
                    <Badge tone={riskTone(p)} dot={false}>
                      {riskLabel(t, permissionRisk(p))}
                    </Badge>
                  </span>
                  <span className="plg-perm__desc">{permDesc(t, p)}</span>
                </span>
              </Checkbox>
            </div>
          ))}
        </ItemGroup>

        <ItemGroup title={t('plugins.review.addressesTitle')}>
          {panelRows.map((r) => (
            <Item key={r.id} title={t('plugins.review.panelRelay', { panel: r.title })} detail={<span className="plg-mono">{r.upstream}</span>} multiline />
          ))}
          <Item title={t('plugins.review.callback')} detail={<span className="plg-mono">{m.callback?.url ?? t('plugins.review.noCallback')}</span>} multiline />
        </ItemGroup>

        {notice && (
          <p className="plg-alert" role="alert">
            {notice}
          </p>
        )}
        {reviewable ? (
          <div className="plg-actions">
            <Button variant="ghost" className="is-cancel" disabled={!!busy} loading={busy === 'reject'} onClick={() => void reject()}>
              {t('plugins.review.reject')}
            </Button>
            <Button variant="primary" disabled={!!busy || !review.manifestHash} loading={busy === 'approve'} onClick={() => void approve()}>
              {t('plugins.review.approve')}
            </Button>
          </div>
        ) : (
          <p className="set-note">{t('plugins.review.nothingToReview')}</p>
        )}
      </ItemList>
    </Page>
  );
}

/** Overview row in Settings (rendered only while the server supports plugins). */
export function PluginsOverviewItem() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const availability = usePluginStore((s) => s.availability);
  const map = usePluginInstallMap();
  useEffect(() => {
    void loadPluginInstalls();
  }, []);
  if (availability !== 'available') return null;
  const waiting = Object.values(map).filter(needsReview).length;
  return (
    <Item
      title={t('plugins.title')}
      subtitle={t('plugins.subtitle')}
      left={<Puzzle size={18} />}
      right={
        <span className="plg-row-right">
          {waiting > 0 && <StatusDot status="permission" />}
          <ChevronRight size={16} />
        </span>
      }
      onClick={() => navigate('/settings/plugins')}
    />
  );
}
