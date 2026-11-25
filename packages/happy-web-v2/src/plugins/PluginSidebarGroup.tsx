/**
 * B-974d (DESIGN B-973 §1 E1): the sidebar's 「插件」 group — one row per live
 * install with a granted sidebar entry: icon, title, badge. A row whose
 * machine is offline is greyed, keeps the last badge and says so in its
 * tooltip. Nothing renders when the server has no plugins (404) or no
 * install has a sidebar entry.
 */
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { usePluginInstallMap, usePluginsAvailable } from '@/sync/pluginStore';
import { formatBadge, sidebarInstalls } from './pluginModel';
import { pluginPanelPath } from './pluginRoutes';
import { PluginIcon } from './PluginIcon';
import './pluginSurfaces.css';

export function PluginSidebarGroup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const available = usePluginsAvailable();
  const map = usePluginInstallMap();
  const machines = useAllMachines({ includeOffline: true });
  const rows = useMemo(() => sidebarInstalls(Object.values(map)), [map]);
  const online = useMemo(() => new Set(machines.filter(isMachineOnline).map((m) => m.id)), [machines]);
  if (!available || rows.length === 0) return null;
  return (
    <div className="plg-sb" role="group" aria-label={t('plugins.sidebar.group')}>
      <div className="plg-sb-title">{t('plugins.sidebar.group')}</div>
      {rows.map((i) => {
        const path = pluginPanelPath(i.id, i.sidebar!.panel);
        const current = location.pathname === `/plugins/${encodeURIComponent(i.id)}/${encodeURIComponent(i.sidebar!.panel)}` || location.pathname.startsWith(`/plugins/${encodeURIComponent(i.id)}/`);
        const offline = !online.has(i.machineId);
        const badge = formatBadge(i.badge);
        const title = [i.sidebar!.title, i.badge?.label, offline ? t('plugins.sidebar.offline') : null].filter(Boolean).join(' · ');
        return (
          <button
            key={i.id}
            type="button"
            className="sb-cap-row plg-sb-row"
            data-plugin={i.id}
            data-offline={offline || undefined}
            aria-current={current ? 'page' : undefined}
            aria-label={badge ? `${title} · ${badge}` : title}
            title={title}
            onClick={() => navigate(path)}
          >
            <PluginIcon icon={i.icon} size={16} />
            <span className="sb-cap-name">{i.sidebar!.title}</span>
            {badge && (
              <span className={`sb-nav-attn mono${i.badge?.tone === 'attention' && !i.muted ? '' : ' plg-sb-badge--quiet'}`} aria-hidden>
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
