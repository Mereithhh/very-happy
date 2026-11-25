/**
 * B-974d (DESIGN B-973 §1 E3, §5.3, T6): plugin cards in 「需要我决策」 (/board,
 * beside the automation and Issues bands). Renders nothing when no plugin
 * item is open or answered, or when the server has no plugins.
 *
 * Each card: the non-removable source line 「插件 · 名字 · 机器」, title,
 * restricted markdown body, then 2–4 buttons (choice), one input (input) or
 * 「知道了」 (notice). Buttons only call back the plugin; none triggers a Very
 * Happy action. A muted or non-live install, or one without `decisions`,
 * shows nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellOff, ChevronRight, ExternalLink, Puzzle } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu, Button, toast, type MenuItemDef } from '@/ui';
import { useAllMachines } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { OWNER_LOGIN_REQUIRED } from '@/sync/apiAttention';
import { setPluginMuted } from '@/sync/apiPlugins';
import { applyInstall, usePluginInstallMap, usePluginsAvailable } from '@/sync/pluginStore';
import { loadPluginDecisions, respondToPluginDecision, usePluginDecisions, type OwnerSystemCard, type PluginDecisionResponse, type PluginDecisionView } from '@/sync/pluginDecisions';
import { canOpenPanel } from './pluginModel';
import { pluginPanelPath } from './pluginRoutes';
import { hasGrant, type PluginInstallView } from './pluginTypes';
import { PluginMarkdown } from './PluginMarkdown';
import { PluginSourceLine } from './PluginWidgets';
import './pluginSurfaces.css';

/** Cards to show: live installs with `decisions`, open first then answered, newest first. */
export function visibleDecisions(items: readonly PluginDecisionView[], installs: Record<string, PluginInstallView>): { item: PluginDecisionView; install: PluginInstallView }[] {
  return items
    .filter((d) => d.state !== 'closed')
    .map((item) => ({ item, install: installs[item.installId] }))
    .filter((x): x is { item: PluginDecisionView; install: PluginInstallView } => !!x.install && hasGrant(x.install, 'decisions'))
    .sort((a, b) => (a.item.state === 'open' ? 0 : 1) - (b.item.state === 'open' ? 0 : 1) || b.item.updatedAt - a.item.updatedAt);
}

export function usePluginDecisionsSync(): void {
  const available = usePluginsAvailable();
  useEffect(() => {
    if (!available) return;
    void loadPluginDecisions();
    return sync.onResume(() => {
      void loadPluginDecisions();
    });
  }, [available]);
}

export function PluginDecisions() {
  const { t } = useTranslation();
  usePluginDecisionsSync();
  const available = usePluginsAvailable();
  const itemsMap = usePluginDecisions((s) => s.items);
  const systemMap = usePluginDecisions((s) => s.system);
  const system = useMemo(() => Object.values(systemMap).filter((c) => c.open).sort((a, b) => b.updatedAt - a.updatedAt), [systemMap]);
  const installs = usePluginInstallMap();
  const machines = useAllMachines({ includeOffline: true });
  const rows = useMemo(() => visibleDecisions(Object.values(itemsMap), installs), [itemsMap, installs]);
  if (!available || (rows.length === 0 && system.length === 0)) return null;
  const open = rows.filter((r) => r.item.state === 'open').length + system.length;
  return (
    <section className="plg-dec" aria-labelledby="plg-dec-title" data-testid="plugin-decisions">
      <header className="plg-dec-head">
        <span id="plg-dec-title" className="plg-dec-title">
          {t('plugins.decision.sectionTitle')}
          {open > 0 && <span className="plg-dec-count mono">{open}</span>}
        </span>
      </header>
      <ul className="plg-dec-list">
        {system.map((c) => (
          <li key={c.id}>
            <OwnerSystemCardView card={c} />
          </li>
        ))}
        {rows.map(({ item, install }) => {
          const m = machines.find((x) => x.id === install.machineId);
          return (
            <li key={item.id}>
              <PluginDecisionCard item={item} install={install} machineName={m ? machineLabel(m) : null} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 「插件安装待批准」 — host-generated (source owner-system); opens the review page. */
export function OwnerSystemCardView({ card }: { card: OwnerSystemCard }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const href = card.installId ? `/settings/plugins/${encodeURIComponent(card.installId)}/review` : '/settings/plugins';
  return (
    <button type="button" className="plg-card plg-card--system" data-testid="plugin-system-card" onClick={() => navigate(href)}>
      <span className="plg-source">
        <Puzzle size={13} aria-hidden />
        <span>{t('plugins.title')}</span>
      </span>
      <span className="plg-card-title">{card.title}</span>
      <span className="plg-card-link">
        {t('plugins.detail.reviewCta')} <ChevronRight size={13} aria-hidden />
      </span>
    </button>
  );
}

export function PluginDecisionCard({ item, install, machineName }: { item: PluginDecisionView; install: PluginInstallView; machineName: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [text, setText] = useState('');
  const answered = item.state !== 'open';
  const panelId = install.sidebar?.panel ?? install.panels[0]?.id;
  const canPanel = !!item.panelPath && !!panelId && canOpenPanel(install, panelId);

  const respond = async (key: string, body: PluginDecisionResponse) => {
    setBusy(key);
    try {
      await respondToPluginDecision(item, body);
      if (body.action === 'submit') setText('');
    } catch (e) {
      const code = e instanceof Error ? e.message : 'error';
      toast.error(code === OWNER_LOGIN_REQUIRED ? t('plugins.review.loginRequired') : t('plugins.review.failed', { code }));
    } finally {
      setBusy(null);
    }
  };

  const menu: MenuItemDef[] = [
    {
      key: 'mute',
      label: t('plugins.decision.mute'),
      icon: BellOff,
      onSelect: () => {
        void setPluginMuted(install.id, true)
          .then(applyInstall)
          .catch(() => toast.error(t('plugins.review.failed', { code: 'mute' })));
      },
    },
  ];

  const answer =
    item.response?.choice != null ? item.options.find((o) => o.id === item.response?.choice)?.label ?? item.response.choice : item.response?.text ?? null;

  return (
    <article className="plg-card" data-state={item.state} data-kind={item.kind} data-plugin={install.id}>
      <div className="plg-card-top">
        <PluginSourceLine install={install} machineName={machineName} />
        {!install.muted && (
          <ActionDropdownMenu align="end" items={menu}>
            <button type="button" className="plg-card-more" aria-label={t('plugins.decision.mute')} title={t('plugins.decision.mute')}>
              <BellOff size={14} />
            </button>
          </ActionDropdownMenu>
        )}
      </div>
      <h3 className="plg-card-title">{item.title}</h3>
      {item.bodyMd && <PluginMarkdown text={item.bodyMd} />}
      {answered ? (
        <div className="plg-card-answered">
          <span>
            {t('plugins.decision.answered')}
            {answer ? ` · ${answer}` : ''}
          </span>
          {item.delivery === 'failed' && <span className="plg-card-warn">{t('plugins.decision.deliveryFailed')}</span>}
          {item.delivery !== 'failed' && item.unacknowledged && <span className="plg-card-warn">{t('plugins.decision.unacknowledged')}</span>}
        </div>
      ) : item.kind === 'choice' ? (
        <div className="plg-card-actions">
          {item.options.map((o) => (
            <Button key={o.id} size="sm" variant={o.style === 'primary' ? 'primary' : o.style === 'danger' ? 'danger' : 'secondary'} title={o.detail} loading={busy === o.id} disabled={!!busy} onClick={() => void respond(o.id, { action: 'choose', choice: o.id })}>
              {o.label}
            </Button>
          ))}
        </div>
      ) : item.kind === 'input' ? (
        <form
          className="plg-card-input"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (v) void respond('submit', { action: 'submit', text: v });
          }}
        >
          {item.input?.multiline ? (
            <textarea value={text} maxLength={item.input.maxLength} placeholder={item.input.placeholder ?? t('plugins.decision.inputPlaceholder')} rows={3} onChange={(e) => setText(e.target.value)} aria-label={item.title} />
          ) : (
            <input type="text" value={text} maxLength={item.input?.maxLength ?? 500} placeholder={item.input?.placeholder ?? t('plugins.decision.inputPlaceholder')} onChange={(e) => setText(e.target.value)} aria-label={item.title} />
          )}
          <Button type="submit" size="sm" variant="primary" loading={busy === 'submit'} disabled={!!busy || !text.trim()}>
            {t('plugins.decision.send')}
          </Button>
        </form>
      ) : (
        <div className="plg-card-actions">
          <Button size="sm" variant="secondary" loading={busy === 'dismiss'} disabled={!!busy} onClick={() => void respond('dismiss', { action: 'resolve' })}>
            {t('plugins.decision.dismiss')}
          </Button>
        </div>
      )}
      {canPanel && (
        <button type="button" className="plg-card-link" onClick={() => navigate(pluginPanelPath(install.id, panelId!, item.panelPath))}>
          <ExternalLink size={13} /> {t('plugins.decision.openInPlugin')}
        </button>
      )}
    </article>
  );
}
