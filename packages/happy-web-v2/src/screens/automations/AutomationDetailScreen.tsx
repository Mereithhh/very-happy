/**
 * B-498 /automations/:id — one automation: the action it performs,
 * its sticky sessions and the timeline of its recent runs (status, source,
 * duration, expandable summary, session link, ack/cancel on runs that
 * still want a decision).
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Pause, Pencil, Play, Trash2, X, Zap } from 'lucide-react';
import type { Automation, AutomationRun } from '@slopus/happy-wire';
import { BackButton } from '@/app/BackButton';
import { Modal } from '@/modal';
import { CopyButton, EmptyState, Spinner, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { AUTOMATIONS_DETAIL_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import {
  describeAction,
  describeTrigger,
  fmtAbsolute,
  fmtRelative,
  fmtSpan,
  isRunOpen,
  langOf,
  promptPreview,
  runDurationMs,
  runMoment,
} from './automationPresentation';
import { fireSnippets } from './automationForm';
import { MachineTag, reportAutomationError, RunStatusBadge, SessionLink, useAttentionReason, useNow, useSourceLabel } from './AutomationShared';
import './automations.css';

function ActionCard({ automation }: { automation: Automation }) {
  const { t, lang } = useTranslation();
  const [full, setFull] = useState(false);
  const l = langOf(lang);
  const text = describeAction(automation.action, l);
  const kindLabel = text.kind === 'spawn' ? t('automations.actionSpawn') : text.kind === 'send' ? t('automations.actionSend') : t('automations.actionScript');
  const fullBody =
    automation.action.kind === 'script'
      ? automation.action.command.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')
      : automation.action.prompt;
  const canExpand = text.truncated || promptPreview(fullBody).truncated;
  return (
    <section className="au-section">
      <h2 className="au-section-title">{t('automations.action')}</h2>
      <div className="au-action-kind">
        <span>{kindLabel}</span>
        <span className="au-dot" aria-hidden>·</span>
        <span className="mono au-action-head">{text.headline}</span>
      </div>
      <pre className="au-pre">{full ? fullBody : text.body}{!full && text.truncated ? '…' : ''}</pre>
      {canExpand && (
        <button type="button" className="au-link" onClick={() => setFull((v) => !v)}>
          {full ? t('automations.promptCollapse') : t('automations.promptTruncated')}
        </button>
      )}
    </section>
  );
}

/** A manual automation IS a trigger: show the ways to fire it, copyable. */
function FireCard({ name }: { name: string }) {
  const { t } = useTranslation();
  const snippets = fireSnippets(name);
  const rows: Array<[string, string]> = [
    [t('automations.fireCli') as string, snippets.cli],
    [t('automations.fireCliPayload') as string, snippets.cliPayload],
    [t('automations.fireMcp') as string, snippets.mcp],
  ];
  return (
    <section className="au-section au-fire">
      <h2 className="au-section-title">{t('automations.fireTitle')}</h2>
      <p className="au-muted au-section-empty">{t('automations.fireBody')}</p>
      {rows.map(([label, cmd]) => (
        <div key={label} className="au-fire-row">
          <span className="au-fire-label">{label}</span>
          <div className="au-fire-cmd">
            <code>{cmd}</code>
            <CopyButton text={cmd} />
          </div>
        </div>
      ))}
      <p className="au-field-hint">{t('automations.fireRunNowHint')}</p>
    </section>
  );
}

function RunRow({
  run,
  now,
  busy,
  onAck,
  onCancel,
}: {
  run: AutomationRun;
  now: number;
  busy: boolean;
  onAck: () => void;
  onCancel: () => void;
}) {
  const { t, lang } = useTranslation();
  const source = useSourceLabel();
  const reason = useAttentionReason();
  const l = langOf(lang);
  const at = runMoment(run);
  const duration = runDurationMs(run, now);
  const hasBody = Boolean(run.summary || run.error);
  return (
    <li className={`au-run${run.needsAttention ? ' au-run--attn' : ''}`}>
      <div className="au-run-head">
        <RunStatusBadge status={run.status} />
        <span className="au-run-source mono">{source(run.source)}</span>
        <time className="mono au-run-time" dateTime={new Date(at).toISOString()} title={fmtAbsolute(at, l)}>
          {fmtRelative(at, now, l)}
        </time>
        {duration !== null && <span className="mono au-muted">{fmtSpan(duration)}</span>}
        {run.exitCode !== null && run.exitCode !== 0 && (
          <span className="mono au-muted">
            {t('automations.exitCode')} {run.exitCode}
          </span>
        )}
        <span className="au-run-spacer" />
        {run.sessionId ? <SessionLink sessionId={run.sessionId} /> : <span className="au-muted au-run-nosession">{t('automations.noSession')}</span>}
      </div>
      {run.needsAttention && (
        <div className="au-run-attn">
          <span className="au-attn-reason">{reason(run)}</span>
          <div className="au-run-attn-actions">
            <button type="button" className="au-btn" disabled={busy} onClick={onAck}>
              <Check size={13} /> {t('automations.ack')}
            </button>
            {isRunOpen(run.status) && (
              <button type="button" className="au-btn au-btn--danger" disabled={busy} onClick={onCancel}>
                <X size={13} /> {t('automations.cancelRun')}
              </button>
            )}
          </div>
        </div>
      )}
      {!run.needsAttention && isRunOpen(run.status) && (
        <div className="au-run-attn-actions">
          <button type="button" className="au-btn au-btn--danger" disabled={busy} onClick={onCancel}>
            <X size={13} /> {t('automations.cancelRun')}
          </button>
        </div>
      )}
      {hasBody && (
        <details className="au-run-body">
          <summary className="au-run-summary-toggle">
            <span className="au-run-summary-preview">{(run.error ?? run.summary ?? '').split('\n')[0]}</span>
          </summary>
          {run.error && (
            <pre className="au-pre au-pre--error">
              {run.error}
            </pre>
          )}
          {run.summary && <pre className="au-pre">{run.summary}</pre>}
        </details>
      )}
    </li>
  );
}

export function AutomationDetailScreen() {
  const { id = '' } = useParams();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const l = langOf(lang);
  const enabled = useAutomations((s) => s.enabled);
  const automation = useAutomations((s) => s.automations.find((a) => a.id === id) ?? null);
  const runs = useAutomations((s) => s.runsByAutomation[id]);
  const stickies = useAutomations((s) => s.stickiesByAutomation[id]);
  const error = useAutomations((s) => s.error);
  const loadedAt = useAutomations((s) => s.loadedAt);
  const refreshAutomation = useAutomations((s) => s.refreshAutomation);
  const rerun = useAutomations((s) => s.rerun);
  const pause = useAutomations((s) => s.pause);
  const resume = useAutomations((s) => s.resume);
  const remove = useAutomations((s) => s.remove);
  const ack = useAutomations((s) => s.ack);
  const cancel = useAutomations((s) => s.cancel);
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => refreshAutomation(id), [refreshAutomation, id]);
  useAutomationsPoll(refresh, AUTOMATIONS_DETAIL_POLL_MS, id.length > 0);

  const guard = useCallback(
    async (key: string, work: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      try {
        await work();
      } catch (e) {
        reportAutomationError(e, t);
      } finally {
        setBusy(null);
      }
    },
    [busy, t],
  );

  const sortedRuns = useMemo(() => (runs ?? []).slice().sort((a, b) => runMoment(b) - runMoment(a)), [runs]);

  if (enabled === false) {
    return (
      <div className="au">
        <header className="au-header">
          <BackButton />
          <span className="au-title">{t('automations.title')}</span>
        </header>
        <div className="au-body">
          <EmptyState compact title={t('automations.disabledTitle') as string} description={t('automations.disabledBody') as string} icon={<Zap size={28} />} />
        </div>
      </div>
    );
  }
  if (!automation) {
    return (
      <div className="au">
        <header className="au-header">
          <BackButton />
          <span className="au-title">{t('automations.title')}</span>
        </header>
        <div className="au-body">
          {runs !== undefined || (loadedAt && !error) ? (
            <EmptyState
              compact
              title={t('automations.notFound') as string}
              icon={<Zap size={28} />}
              actions={
                <button type="button" className="au-btn" onClick={() => navigate('/automations')}>
                  {t('automations.backToList')}
                </button>
              }
            />
          ) : error ? (
            <div className="au-error">{t('automations.loadFailed', { code: error })}</div>
          ) : (
            <div className="au-loading">
              <Spinner size={14} /> {t('common.loading')}
            </div>
          )}
        </div>
      </div>
    );
  }

  const paused = automation.status === 'paused';
  const trigger = describeTrigger(automation.trigger, l);
  const cancelRun = (run: AutomationRun) =>
    void guard(`cancel:${run.id}`, async () => {
      const ok = await Modal.confirm(t('automations.cancelRunTitle') as string, t('automations.cancelRunConfirm', { name: automation.name }) as string, { destructive: true });
      if (!ok) return;
      await cancel(run.id);
      toast.success(t('automations.cancelled') as string);
    });

  return (
    <div className="au">
      <header className="au-header">
        <BackButton />
        <span className="au-title mono">{automation.name}</span>
        {paused && <span className="au-pill mono">{t('automations.statusPaused')}</span>}
        <div className="au-header-tools">
          <button type="button" className="au-btn au-btn--primary" title={t('automations.runNow') as string} aria-label={t('automations.runNow') as string} disabled={busy === 'run'} onClick={() => void guard('run', async () => { await rerun(automation.id); toast.success(t('automations.runQueued', { name: automation.name }) as string); })}>
            <Zap size={13} /> <span className="au-btn-label">{t('automations.runNow')}</span>
          </button>
          <button
            type="button"
            className="au-btn"
            title={(paused ? t('automations.resume') : t('automations.pause')) as string}
            aria-label={(paused ? t('automations.resume') : t('automations.pause')) as string}
            disabled={busy === 'toggle'}
            onClick={() =>
              void guard('toggle', async () => {
                if (paused) { await resume(automation.id); toast.success(t('automations.resumed') as string); }
                else { await pause(automation.id); toast.success(t('automations.paused') as string); }
              })
            }
          >
            {paused ? <Play size={13} /> : <Pause size={13} />} <span className="au-btn-label">{paused ? t('automations.resume') : t('automations.pause')}</span>
          </button>
          <button
            type="button"
            className="au-btn au-btn--icon"
            aria-label={t('automations.editAutomation') as string}
            title={t('automations.editAutomation') as string}
            onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}/edit`)}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="au-btn au-btn--danger au-btn--icon"
            aria-label={t('automations.deleteAutomation') as string}
            title={t('automations.deleteAutomation') as string}
            disabled={busy === 'delete'}
            onClick={() =>
              void guard('delete', async () => {
                const ok = await Modal.confirm(t('automations.deleteAutomation') as string, t('automations.deleteConfirm', { name: automation.name }) as string, { destructive: true });
                if (!ok) return;
                await remove(automation.id);
                toast.success(t('automations.deleted') as string);
                navigate('/automations', { replace: true });
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      </header>
      <div className="au-body">
        {error && <div className="au-error">{t('automations.loadFailed', { code: error })}</div>}
        {automation.description && <p className="au-desc">{automation.description}</p>}
        <dl className="au-facts">
          <div className="au-fact">
            <dt>{t('automations.trigger')}</dt>
            <dd title={trigger.detail}>{trigger.summary}</dd>
          </div>
          <div className="au-fact">
            <dt>{t('automations.machine')}</dt>
            <dd><MachineTag machineId={automation.machineId} /></dd>
          </div>
          <div className="au-fact">
            <dt>{t('automations.nextRun')}</dt>
            <dd className="mono">
              {automation.nextRunAt && !paused ? (
                <time dateTime={new Date(automation.nextRunAt).toISOString()} title={fmtAbsolute(automation.nextRunAt, l)}>
                  {fmtRelative(automation.nextRunAt, now, l)} · {fmtAbsolute(automation.nextRunAt, l)}
                </time>
              ) : (
                t('automations.none')
              )}
            </dd>
          </div>
          <div className="au-fact">
            <dt>{t('automations.lastResult')}</dt>
            <dd>
              {automation.lastRunStatus ? (
                <span className="au-last">
                  <RunStatusBadge status={automation.lastRunStatus} />
                  {automation.lastRunAt && <span className="mono au-muted">{fmtRelative(automation.lastRunAt, now, l)}</span>}
                </span>
              ) : (
                <span className="mono au-muted">{t('automations.never')}</span>
              )}
            </dd>
          </div>
          <div className="au-fact">
            <dt>{t('automations.maxRuntime')}</dt>
            <dd className="mono">
              {fmtSpan(automation.maxRuntimeMs)} · {automation.concurrency === 'queue' ? t('automations.concurrencyQueue') : t('automations.concurrencySkip')} · {t('automations.version')}{automation.version}
            </dd>
          </div>
        </dl>

        {automation.trigger.kind === 'manual' && <FireCard name={automation.name} />}

        <ActionCard automation={automation} />

        <section className="au-section">
          <h2 className="au-section-title">{t('automations.stickies')}</h2>
          {!stickies || stickies.length === 0 ? (
            <p className="au-muted au-section-empty">{t('automations.noStickies')}</p>
          ) : (
            <ul className="au-stickies">
              {stickies.map((s) => (
                <li key={s.key} className="au-sticky">
                  <span className="mono au-sticky-key">{s.key}</span>
                  <span className="au-dot" aria-hidden>→</span>
                  <SessionLink sessionId={s.sessionId} />
                  <time className="mono au-muted" dateTime={new Date(s.updatedAt).toISOString()} title={fmtAbsolute(s.updatedAt, l)}>
                    {fmtRelative(s.updatedAt, now, l)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="au-section">
          <h2 className="au-section-title">
            {t('automations.runs')}
            {sortedRuns.length > 0 && <span className="au-count mono">{sortedRuns.length}</span>}
          </h2>
          {runs === undefined ? (
            <div className="au-loading"><Spinner size={14} /> {t('common.loading')}</div>
          ) : sortedRuns.length === 0 ? (
            <p className="au-muted au-section-empty">{t('automations.noRuns')}</p>
          ) : (
            <ul className="au-runs">
              {sortedRuns.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  now={now}
                  busy={busy === `ack:${run.id}` || busy === `cancel:${run.id}`}
                  onAck={() => void guard(`ack:${run.id}`, async () => { await ack(run.id); toast.success(t('automations.acked') as string); })}
                  onCancel={() => cancelRun(run)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
