/**
 * B-498 /board/automations — the account's automations as a compact table:
 * name, trigger in words, target machine (online?), next run, last result,
 * and the owner's three verbs (run now, pause/resume, delete). The
 * "needs my decision" band sits above the table, same component as /board.
 *
 * Read-mostly by design: creation/editing stays with the CLI / MCP tools for
 * this batch (see backlog B-498).
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoreHorizontal, Pause, Play, Trash2, Zap } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { Modal } from '@/modal';
import { ActionDropdownMenu, EmptyState, Spinner, toast, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { AUTOMATIONS_OVERVIEW_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import type { Automation } from '@slopus/happy-wire';
import { AttentionSection } from './AttentionSection';
import { describeTrigger, fmtAbsolute, fmtRelative, langOf, sortAutomations } from './automationPresentation';
import { MachineTag, reportAutomationError, RunStatusBadge, useNow } from './AutomationShared';
import './automations.css';

function AutomationRow({
  automation,
  attentionCount,
  now,
  busy,
  onRun,
  onPause,
  onResume,
  onDelete,
}: {
  automation: Automation;
  attentionCount: number;
  now: number;
  busy: boolean;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const l = langOf(lang);
  const trigger = describeTrigger(automation.trigger, l);
  const paused = automation.status === 'paused';
  const href = `/board/automations/${encodeURIComponent(automation.id)}`;
  const menu: MenuItemDef[] = [
    { key: 'run', label: t('automations.runNow') as string, icon: Zap, disabled: busy, onSelect: onRun },
    paused
      ? { key: 'resume', label: t('automations.resume') as string, icon: Play, disabled: busy, onSelect: onResume }
      : { key: 'pause', label: t('automations.pause') as string, icon: Pause, disabled: busy, onSelect: onPause },
    { key: 'delete', label: t('automations.deleteAutomation') as string, icon: Trash2, danger: true, separatorBefore: true, disabled: busy, onSelect: onDelete },
  ];
  return (
    <li className={`au-row${paused ? ' au-row--paused' : ''}`}>
      <div className="au-row-main">
        <div className="au-row-title">
          <button type="button" className="au-row-name" onClick={() => navigate(href)}>
            {automation.name}
          </button>
          {paused && <span className="au-pill mono">{t('automations.statusPaused')}</span>}
          {attentionCount > 0 && (
            <span className="au-pill au-pill--attn mono" title={t('automations.decisions') as string}>
              {attentionCount}
            </span>
          )}
        </div>
        {automation.description && <div className="au-row-desc">{automation.description}</div>}
        <div className="au-row-meta">
          <span className="au-trigger" title={trigger.detail}>
            {trigger.summary}
          </span>
          <span className="au-dot" aria-hidden>·</span>
          <MachineTag machineId={automation.machineId} />
        </div>
      </div>
      <div className="au-row-cell au-row-cell--next">
        <span className="au-cell-label">{t('automations.nextRun')}</span>
        {automation.nextRunAt && !paused ? (
          <time className="mono" dateTime={new Date(automation.nextRunAt).toISOString()} title={fmtAbsolute(automation.nextRunAt, l)}>
            {fmtRelative(automation.nextRunAt, now, l)}
          </time>
        ) : (
          <span className="mono au-muted">{t('automations.none')}</span>
        )}
      </div>
      <div className="au-row-cell au-row-cell--last">
        <span className="au-cell-label">{t('automations.lastResult')}</span>
        {automation.lastRunStatus ? (
          <span className="au-last">
            <RunStatusBadge status={automation.lastRunStatus} />
            {automation.lastRunAt && (
              <time className="mono au-muted" dateTime={new Date(automation.lastRunAt).toISOString()} title={fmtAbsolute(automation.lastRunAt, l)}>
                {fmtRelative(automation.lastRunAt, now, l)}
              </time>
            )}
          </span>
        ) : (
          <span className="mono au-muted">{t('automations.never')}</span>
        )}
      </div>
      <div className="au-row-actions">
        <button type="button" className="au-btn" disabled={busy} title={t('automations.runNow') as string} onClick={onRun}>
          <Zap size={13} /> <span className="au-btn-label">{t('automations.runNow')}</span>
        </button>
        <button type="button" className="au-btn" disabled={busy} title={(paused ? t('automations.resume') : t('automations.pause')) as string} onClick={paused ? onResume : onPause}>
          {paused ? <Play size={13} /> : <Pause size={13} />} <span className="au-btn-label">{paused ? t('automations.resume') : t('automations.pause')}</span>
        </button>
        <ActionDropdownMenu items={menu} align="end" sideOffset={4}>
          <button type="button" className="au-btn au-btn--icon" aria-label={t('automations.actions') as string}>
            <MoreHorizontal size={14} />
          </button>
        </ActionDropdownMenu>
      </div>
    </li>
  );
}

export function AutomationsScreen() {
  const { t } = useTranslation();
  const enabled = useAutomations((s) => s.enabled);
  const automations = useAutomations((s) => s.automations);
  const attention = useAutomations((s) => s.attention);
  const error = useAutomations((s) => s.error);
  const loadedAt = useAutomations((s) => s.loadedAt);
  const refreshOverview = useAutomations((s) => s.refreshOverview);
  const rerun = useAutomations((s) => s.rerun);
  const pause = useAutomations((s) => s.pause);
  const resume = useAutomations((s) => s.resume);
  const remove = useAutomations((s) => s.remove);
  const now = useNow();
  const [busyId, setBusyId] = useState<string | null>(null);
  useAutomationsPoll(refreshOverview, AUTOMATIONS_OVERVIEW_POLL_MS);

  const attentionByAutomation = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of attention) counts[run.automationId] = (counts[run.automationId] ?? 0) + 1;
    return counts;
  }, [attention]);
  const rows = useMemo(() => sortAutomations(automations, attentionByAutomation), [automations, attentionByAutomation]);

  const guard = useCallback(
    async (id: string, work: () => Promise<void>) => {
      if (busyId) return;
      setBusyId(id);
      try {
        await work();
      } catch (e) {
        reportAutomationError(e, t);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, t],
  );

  const onDelete = (automation: Automation) =>
    void guard(automation.id, async () => {
      const ok = await Modal.confirm(t('automations.deleteAutomation') as string, t('automations.deleteConfirm', { name: automation.name }) as string, { destructive: true });
      if (!ok) return;
      await remove(automation.id);
      toast.success(t('automations.deleted') as string);
    });

  let body: React.ReactNode;
  if (enabled === false) {
    body = <EmptyState compact title={t('automations.disabledTitle') as string} description={t('automations.disabledBody') as string} icon={<Zap size={28} />} />;
  } else if (enabled === null && !loadedAt) {
    body = error ? (
      <div className="au-error">{t('automations.loadFailed', { code: error })}</div>
    ) : (
      <div className="au-loading">
        <Spinner size={14} /> {t('common.loading')}
      </div>
    );
  } else if (rows.length === 0) {
    body = <EmptyState compact title={t('automations.emptyTitle') as string} description={<code className="au-empty-code">{t('automations.emptyBody')}</code>} icon={<Zap size={28} />} />;
  } else {
    body = (
      <ul className="au-list">
        {rows.map((automation) => (
          <AutomationRow
            key={automation.id}
            automation={automation}
            attentionCount={attentionByAutomation[automation.id] ?? 0}
            now={now}
            busy={busyId === automation.id}
            onRun={() => void guard(automation.id, async () => { await rerun(automation.id); toast.success(t('automations.runQueued', { name: automation.name }) as string); })}
            onPause={() => void guard(automation.id, async () => { await pause(automation.id); toast.success(t('automations.paused') as string); })}
            onResume={() => void guard(automation.id, async () => { await resume(automation.id); toast.success(t('automations.resumed') as string); })}
            onDelete={() => onDelete(automation)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="au">
      <header className="au-header">
        <BackButton />
        <span className="au-title">{t('automations.title')}</span>
        {rows.length > 0 && <span className="au-count mono">{rows.length}</span>}
      </header>
      <div className="au-body">
        {error && loadedAt && <div className="au-error">{t('automations.loadFailed', { code: error })}</div>}
        <AttentionSection poll={false} />
        {body}
      </div>
    </div>
  );
}
