/**
 * B-974d (DESIGN B-973 §1 E4, §5.4): plugin widgets in the session header.
 *
 * One chip per plugin (icon + status label + tone), at most 3 per session,
 * only from live installs with `session.widget` on the session's own machine;
 * archived sessions show none. Clicking a chip opens a card (Radix Popover):
 * the plugin source line, its plain text, ≤ 2 actions and 「在面板中打开」.
 * An action with `confirm` asks first (host confirm), then calls the server,
 * which queues `widget.action` for the plugin. Nothing the plugin sends is
 * rendered as HTML.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, toast } from '@/ui';
import { Modal } from '@/modal';
import { useMachine, useSession } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { PluginsApiError, sendWidgetAction } from '@/sync/apiPlugins';
import { loadSessionWidgets, usePluginInstallMap, usePluginsAvailable, useSessionWidgets } from '@/sync/pluginStore';
import { canOpenPanel, visibleWidgets } from './pluginModel';
import { pluginPanelPath } from './pluginRoutes';
import { hasGrant, type PluginInstallView, type PluginWidgetAction, type PluginWidgetView } from './pluginTypes';
import { PluginIcon } from './PluginIcon';
import { LegacyCredentialsNotice } from './LegacyCredentialsNotice';
import './pluginSurfaces.css';

export function PluginWidgetChips({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const available = usePluginsAvailable();
  const session = useSession(sessionId);
  const widgets = useSessionWidgets(sessionId);
  const installs = usePluginInstallMap();
  useEffect(() => {
    if (available) void loadSessionWidgets(sessionId);
  }, [available, sessionId]);
  if (!available || !session) return null;
  const rows = visibleWidgets(widgets, Object.values(installs), { id: sessionId, machineId: session.metadata?.machineId, archived: !!session.archivedAt });
  // B-974e: the server refuses widgets on a session without a data key (legacy
  // CLI credentials), so a plugin allowed to put one here never shows up.
  // Say why, once, instead of showing nothing.
  const blockedInstall = rows.length === 0 && session.legacyKey && !session.archivedAt
    ? legacyWidgetInstall(Object.values(installs), session.metadata?.machineId)
    : null;
  if (blockedInstall) return <span className="plg-chips" data-testid="plugin-widget-chips"><LegacyWidgetChip install={blockedInstall} compact={compact} /></span>;
  if (rows.length === 0) return null;
  return (
    <span className="plg-chips" data-testid="plugin-widget-chips">
      {rows.map(({ widget, install }) => (
        <PluginWidgetChip key={install.id} widget={widget} install={install} compact={compact} />
      ))}
    </span>
  );
}

/** A live install on this machine that may put a widget on its sessions. */
export function legacyWidgetInstall(installs: readonly PluginInstallView[], machineId: string | null | undefined): PluginInstallView | null {
  if (!machineId) return null;
  return installs.find((i) => i.machineId === machineId && hasGrant(i, 'session.widget')) ?? null;
}

function LegacyWidgetChip({ install, compact }: { install: PluginInstallView; compact?: boolean }) {
  const { t } = useTranslation();
  const machine = useMachine(install.machineId);
  const label = t('plugins.legacy.chip');
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="plg-chip" data-tone="warning" data-legacy="" title={label} aria-label={`${t('plugins.decision.source')} · ${install.name} · ${label}`}>
          <AlertTriangle size={13} />
          {!compact && <span className="plg-chip-text">{label}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="plg-widget-card plg-widget-card--legacy" align="end" sideOffset={6} collisionPadding={12}>
          <div className="plg-widget-body">
            <PluginSourceLine install={install} machineName={machine ? machineLabel(machine) : null} />
            <LegacyCredentialsNotice install={install} machineName={machine ? machineLabel(machine) : null} compact />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PluginWidgetChip({ widget, install, compact }: { widget: PluginWidgetView; install: PluginInstallView; compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = `${install.name}: ${widget.status.label}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="plg-chip" data-tone={widget.status.tone} data-plugin={install.id} title={label} aria-label={`${t('plugins.decision.source')} · ${label}`}>
          <PluginIcon icon={install.icon} size={13} />
          {!compact && <span className="plg-chip-text">{widget.status.label}</span>}
          <span className="plg-chip-dot" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="plg-widget-card" align="end" sideOffset={6} collisionPadding={12}>
          <PluginWidgetCard widget={widget} install={install} onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PluginWidgetCard({ widget, install, onDone }: { widget: PluginWidgetView; install: PluginInstallView; onDone: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const machine = useMachine(install.machineId);
  const [busy, setBusy] = useState<string | null>(null);
  const panelId = install.sidebar?.panel ?? install.panels[0]?.id;
  const canPanel = !!panelId && canOpenPanel(install, panelId);

  const act = async (a: PluginWidgetAction) => {
    if (a.confirm) {
      const ok = await Modal.confirm(a.confirm, `${t('plugins.decision.source')} · ${install.name}`, { confirmText: a.label, destructive: a.style === 'danger' });
      if (!ok) return;
    }
    setBusy(a.id);
    try {
      await sendWidgetAction(install.id, widget.sessionId, a.id);
      toast.success(t('plugins.widget.sent'));
      onDone();
    } catch (e) {
      toast.error(t('plugins.review.failed', { code: e instanceof PluginsApiError ? e.code : 'network' }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="plg-widget-body">
      <PluginSourceLine install={install} machineName={machine ? machineLabel(machine) : null} />
      <div className="plg-widget-status" data-tone={widget.status.tone}>
        <span className="plg-chip-dot" aria-hidden />
        {widget.status.label}
      </div>
      {widget.text && <p className="plg-widget-text">{widget.text}</p>}
      <div className="plg-widget-actions">
        {widget.actions.slice(0, 2).map((a) => (
          <Button key={a.id} size="sm" variant={a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'secondary'} loading={busy === a.id} disabled={!!busy} onClick={() => void act(a)}>
            {a.label}
          </Button>
        ))}
        {canPanel && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<ExternalLink size={14} />}
            onClick={() => {
              onDone();
              navigate(pluginPanelPath(install.id, panelId!, widget.panelPath));
            }}
          >
            {t('plugins.widget.openInPanel')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The non-removable source mark: 「插件 · 名字 · 机器」 (T6). Rendered by the host, never by plugin data alone. */
export function PluginSourceLine({ install, machineName }: { install: Pick<PluginInstallView, 'icon' | 'name'>; machineName: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="plg-source" data-testid="plugin-source">
      <PluginIcon icon={install.icon} size={13} />
      <span>
        {t('plugins.decision.source')} · {install.name}
        {machineName ? ` · ${machineName}` : ''}
      </span>
    </div>
  );
}
