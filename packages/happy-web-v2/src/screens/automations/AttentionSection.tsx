/**
 * B-498 "Needs my decision": every automation run with `needsAttention` —
 * an agent waiting for input, a failed / expired run, a run nobody picked up.
 * Sits at the top of /board (and above the automations list); renders
 * NOTHING when there is nothing to decide, so it never reserves space.
 *
 * B-508: the leading round check IS the 「知道了」 (one tap per row, 44px on
 * coarse pointers), the header offers 「全部已读」, and the band no longer
 * shrinks inside a flex column (it used to clip to its first row on
 * /automations). Runs also resolve themselves server-side when the owner
 * replies in a linked session, when the run later reports done, or when the
 * session is archived — see specs/2026-09-attention-lifecycle.md.
 *
 * Other actions per run: open its session, run the automation again, cancel
 * (only while the run is still open).
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, ListChecks, RotateCw, X } from 'lucide-react';
import { Modal } from '@/modal';
import { toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { AUTOMATIONS_BOARD_POLL_MS, useAutomations, useAutomationsPoll } from '@/sync/automationsStore';
import { fmtAbsolute, fmtRelative, isRunOpen, langOf, sortAttentionRuns } from './automationPresentation';
import { reportAutomationError, RunStatusBadge, SessionLink, useAttentionReason, useNow } from './AutomationShared';
import './automations.css';

export function AttentionSection({ poll = true, linkAutomation = true }: { poll?: boolean; linkAutomation?: boolean }) {
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const attention = useAutomations((s) => s.attention);
  const enabled = useAutomations((s) => s.enabled);
  const refreshOverview = useAutomations((s) => s.refreshOverview);
  const ack = useAutomations((s) => s.ack);
  const ackAll = useAutomations((s) => s.ackAll);
  const cancel = useAutomations((s) => s.cancel);
  const rerun = useAutomations((s) => s.rerun);
  const reason = useAttentionReason();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  useAutomationsPoll(refreshOverview, AUTOMATIONS_BOARD_POLL_MS, poll);

  const guard = useCallback(
    async (key: string, work: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      try {
        await work();
      } catch (error) {
        reportAutomationError(error, t);
      } finally {
        setBusy(null);
      }
    },
    [busy, t],
  );

  if (enabled !== true) return null;
  const runs = sortAttentionRuns(attention);
  if (runs.length === 0) return null;
  const l = langOf(lang);

  return (
    <section className="au-attn" aria-labelledby="au-attn-title" data-testid="attention-band">
      <header className="au-attn-head">
        <span id="au-attn-title" className="au-attn-title">
          {t('automations.decisions')}
          <span className="au-attn-count mono">{runs.length}</span>
        </span>
        <span className="au-attn-hint">{t('automations.decisionsHint')}</span>
        {runs.length > 1 && (
          <button
            type="button"
            className="au-btn au-attn-all"
            disabled={busy === 'ack:all'}
            onClick={() => void guard('ack:all', async () => { const n = await ackAll(); toast.success(t('automations.ackAllDone', { count: n }) as string); })}
          >
            <ListChecks size={13} /> {t('automations.ackAll')}
          </button>
        )}
      </header>
      <ul className="au-attn-list">
        {runs.map((run) => {
          const at = run.finishedAt ?? run.updatedAt;
          return (
            <li key={run.id} className="au-attn-row" data-run-id={run.id}>
              <button
                type="button"
                className="au-attn-check"
                aria-label={t('automations.ack') as string}
                title={t('automations.ack') as string}
                disabled={busy === `ack:${run.id}`}
                onClick={() => void guard(`ack:${run.id}`, async () => { await ack(run.id, 'owner'); toast.success(t('automations.acked') as string); })}
              >
                <Check size={14} />
              </button>
              <div className="au-attn-main">
                <div className="au-attn-line">
                  <RunStatusBadge status={run.status} />
                  <span className="au-attn-reason">{reason(run)}</span>
                </div>
                <div className="au-attn-meta">
                  {linkAutomation ? (
                    <button type="button" className="au-link mono" onClick={() => navigate(`/automations/${encodeURIComponent(run.automationId)}`)}>
                      {run.automationName}
                    </button>
                  ) : (
                    <span className="mono">{run.automationName}</span>
                  )}
                  <span className="au-dot" aria-hidden>·</span>
                  <time className="mono" dateTime={new Date(at).toISOString()} title={fmtAbsolute(at, l)}>
                    {fmtRelative(at, now, l)}
                  </time>
                  {run.sessionId && (
                    <>
                      <span className="au-dot" aria-hidden>·</span>
                      <SessionLink sessionId={run.sessionId} />
                    </>
                  )}
                  {run.error && <span className="au-attn-error mono">{run.error}</span>}
                </div>
              </div>
              <div className="au-attn-actions">
                {run.sessionId && (
                  <button type="button" className="au-btn au-btn--primary" onClick={() => navigate(`/session/${encodeURIComponent(run.sessionId!)}`)}>
                    <ArrowUpRight size={13} /> {t('automations.openSession')}
                  </button>
                )}
                <button type="button" className="au-btn" disabled={busy === `rerun:${run.id}`} onClick={() => void guard(`rerun:${run.id}`, async () => { await rerun(run.automationId); toast.success(t('automations.runQueued', { name: run.automationName }) as string); })}>
                  <RotateCw size={13} /> {t('automations.rerun')}
                </button>
                {isRunOpen(run.status) && (
                  <button
                    type="button"
                    className="au-btn au-btn--danger"
                    disabled={busy === `cancel:${run.id}`}
                    onClick={() =>
                      void guard(`cancel:${run.id}`, async () => {
                        const ok = await Modal.confirm(t('automations.cancelRunTitle') as string, t('automations.cancelRunConfirm', { name: run.automationName }) as string, { destructive: true });
                        if (!ok) return;
                        await cancel(run.id);
                        toast.success(t('automations.cancelled') as string);
                      })
                    }
                  >
                    <X size={13} /> {t('automations.cancelRun')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
