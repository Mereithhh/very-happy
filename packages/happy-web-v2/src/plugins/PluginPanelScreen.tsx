/**
 * B-974d (DESIGN B-973 §1 E2, §4.1, §4.2, §4.4): `/plugins/:installId/:panelId`
 * — a plugin panel. Desktop: in the main area; phone: full screen.
 *
 * - Host bar 「插件 · 名字 · 机器」 with 在新窗口打开 and 停用; the title the
 *   panel sets with `host.setTitle` is shown beside it, never instead of it.
 * - The iframe loads `https://<install origin>/__vh/enter?t=<one-time ticket>`
 *   from `POST …/frame-ticket`; a ticket URL on any other origin is refused.
 *   sandbox / allow / referrerpolicy exactly as §4.1.
 * - The postMessage bridge (pluginBridge.ts) checks source + origin and the
 *   CURRENT grant on every call; the iframe is torn down as soon as the
 *   install stops being live or `panel` is revoked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ExternalLink, PowerOff, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useTheme } from '@/ui/theme';
import { Button, Spinner, toast } from '@/ui';
import { Modal } from '@/modal';
import { BackButton } from '@/app/BackButton';
import { useMachine, storage } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { createFrameTicket, disablePluginInstall, PluginsApiError } from '@/sync/apiPlugins';
import { applyInstall, getPluginInstall, requestBadgeRefresh, usePluginInstall, usePluginStore } from '@/sync/pluginStore';
import { PluginBridge, type BridgeMessageEvent } from './pluginBridge';
import { canOpenPanel } from './pluginModel';
import { pluginPanelPath } from './pluginRoutes';
import { hasGrant } from './pluginTypes';
import { PluginIcon } from './PluginIcon';
import { PLUGIN_FRAME_ALLOW, PLUGIN_FRAME_REFERRER_POLICY, PLUGIN_FRAME_SANDBOX, ticketUrlAllowed, withPathFragment } from './pluginFrame';
import './pluginSurfaces.css';

type Phase = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; code: string };

export function PluginPanelScreen() {
  const { installId = '', panelId = '' } = useParams();
  const [search] = useSearchParams();
  const path = search.get('path');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolved: theme } = useTheme();
  const availability = usePluginStore((s) => s.availability);
  const install = usePluginInstall(installId);
  const machine = useMachine(install?.machineId ?? '');
  const online = !!machine && isMachineOnline(machine);
  const panel = install?.panels.find((p) => p.id === panelId) ?? null;
  const openable = canOpenPanel(install, panelId);
  const origin = install?.origin ?? null;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [frameTitle, setFrameTitle] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [disabling, setDisabling] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // One ticket per (install, panel, path, reload). Never reuse: tickets are one-time.
  useEffect(() => {
    setFrameTitle(null);
    if (!openable || !origin || !online) return;
    let live = true;
    setPhase({ kind: 'loading' });
    createFrameTicket(installId, panelId, path)
      .then(({ url }) => {
        if (!live) return;
        if (!ticketUrlAllowed(url, origin)) setPhase({ kind: 'error', code: 'origin_mismatch' });
        else setPhase({ kind: 'ready', url: withPathFragment(url, path) });
      })
      .catch((e) => live && setPhase({ kind: 'error', code: e instanceof PluginsApiError ? e.code : 'network' }));
    return () => {
      live = false;
    };
  }, [installId, panelId, path, openable, origin, online, generation]);

  const isMobile = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const bridge = useMemo(() => {
    if (!origin) return null;
    return new PluginBridge({
      origin,
      panelId,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      host: {
        getInstall: () => getPluginInstall(installId),
        theme: () => themeRef.current,
        locale: () => (typeof navigator !== 'undefined' ? navigator.language : 'en'),
        mobile: () => isMobile,
        setTitle: (title) => setFrameTitle(title),
        navigatePanel: (pid, p) => navigate(pluginPanelPath(installId, pid, p)),
        isSessionOnMachine: (sid, mid) => storage.getState().sessions[sid]?.metadata?.machineId === mid,
        navigateSession: (sid) => navigate(`/session/${encodeURIComponent(sid)}`),
        confirmExternal: (url) => Modal.confirm(t('plugins.panel.externalTitle'), `${t('plugins.panel.externalBody', { name: getPluginInstall(installId)?.name ?? '' })}\n\n${url}`, { confirmText: t('plugins.panel.open') }),
        openExternal: (url) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        refreshBadge: () => requestBadgeRefresh(),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, installId, panelId, generation]);

  useEffect(() => {
    if (!bridge) return;
    const onMessage = (event: MessageEvent) => {
      void bridge.handle(event as unknown as BridgeMessageEvent);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bridge]);

  useEffect(() => {
    bridge?.notifyTheme(theme);
  }, [bridge, theme]);

  const openWindow = useCallback(async () => {
    try {
      // A fresh one-time ticket for the new window; this frame keeps its own session.
      const { url } = await createFrameTicket(installId, panelId, path);
      if (origin && ticketUrlAllowed(url, origin)) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error(t('plugins.panel.failed', { code: e instanceof PluginsApiError ? e.code : 'network' }));
    }
  }, [installId, panelId, path, origin, t]);

  const disable = useCallback(async () => {
    if (!install) return;
    const ok = await Modal.confirm(t('plugins.detail.disableConfirmTitle', { name: install.name }), t('plugins.detail.disableSubtitle'), { confirmText: t('plugins.panel.disable'), destructive: true });
    if (!ok) return;
    setDisabling(true);
    try {
      applyInstall(await disablePluginInstall(install.id));
    } catch (e) {
      toast.error(t('plugins.review.failed', { code: e instanceof PluginsApiError ? e.code : 'network' }));
    } finally {
      setDisabling(false);
    }
  }, [install, t]);

  let blocked: string | null = null;
  if (availability === 'unavailable') blocked = t('plugins.unavailable');
  else if (availability === 'unknown') blocked = null;
  else if (!install || !panel) blocked = t('plugins.panel.notFound');
  else if (!hasGrant(install, 'panel') && (install.state === 'enabled' || install.state === 'update_pending')) blocked = t('plugins.panel.noPermission');
  else if (!openable && install.state !== 'enabled' && install.state !== 'update_pending') blocked = t('plugins.panel.disabled');
  else if (!origin) blocked = t('plugins.panel.noHost');
  else if (!online) blocked = t('plugins.panel.offline');

  const live = !blocked && availability === 'available';
  const machineName = machine ? machineLabel(machine) : t('plugins.unknownMachine');

  return (
    <div className="plg-panel">
      <div className="plg-panel-bar">
        <BackButton />
        <span className="plg-panel-source">
          {install && <PluginIcon icon={install.icon} size={15} />}
          <span className="plg-panel-source-text">
            <span className="plg-panel-kind">{t('plugins.panel.hostLabel')}</span>
            <span aria-hidden> · </span>
            <span className="plg-panel-name">{install?.name ?? installId}</span>
            <span aria-hidden> · </span>
            <span className="plg-panel-machine">{machineName}</span>
          </span>
          {frameTitle && <span className="plg-panel-title" title={frameTitle}>{frameTitle}</span>}
        </span>
        {live && (
          <>
            <button type="button" className="plg-panel-btn" onClick={() => setGeneration((g) => g + 1)} aria-label={t('webPanels.reload')} title={t('webPanels.reload')}>
              <RefreshCw size={15} />
            </button>
            <button type="button" className="plg-panel-btn" onClick={() => void openWindow()} aria-label={t('plugins.panel.openWindow')} title={t('plugins.panel.openWindow')}>
              <ExternalLink size={15} />
            </button>
          </>
        )}
        {install && (install.state === 'enabled' || install.state === 'update_pending') && (
          <Button size="sm" variant="ghost" leftIcon={<PowerOff size={14} />} loading={disabling} onClick={() => void disable()}>
            {t('plugins.panel.disable')}
          </Button>
        )}
      </div>
      {blocked ? (
        <div className="plg-panel-empty" role="status">
          <p>{blocked}</p>
          {install && (
            <Button size="sm" variant="secondary" onClick={() => navigate(`/settings/plugins/${encodeURIComponent(install.id)}`)}>
              {t('plugins.title')}
            </Button>
          )}
        </div>
      ) : !live || phase.kind === 'loading' ? (
        <div className="plg-panel-empty" role="status">
          <Spinner size={16} />
          <p>{t('plugins.panel.loading')}</p>
        </div>
      ) : phase.kind === 'error' ? (
        <div className="plg-panel-empty" role="alert">
          <p>{t('plugins.panel.failed', { code: phase.code })}</p>
          <Button size="sm" variant="secondary" onClick={() => setGeneration((g) => g + 1)}>
            {t('plugins.retry')}
          </Button>
        </div>
      ) : (
        <iframe
          key={`${phase.url}:${generation}`}
          ref={frameRef}
          className="plg-panel-frame"
          src={phase.url}
          title={`${install?.name ?? ''} · ${panel?.title ?? panelId}`}
          sandbox={PLUGIN_FRAME_SANDBOX}
          allow={PLUGIN_FRAME_ALLOW}
          referrerPolicy={PLUGIN_FRAME_REFERRER_POLICY}
        />
      )}
    </div>
  );
}

export default PluginPanelScreen;
