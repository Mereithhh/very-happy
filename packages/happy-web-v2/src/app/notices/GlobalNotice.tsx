import { useEffect, useId, useState } from 'react';
import { Info, TriangleAlert, X } from 'lucide-react';
import type { NoticeView } from '@slopus/happy-wire';
import { useTranslation } from '@/i18n/useTranslation';
import { storage, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { fetchNotices } from '@/sync/apiNotices';
import { useChangelogVisit } from '../changelogReadStore';
import { OVERLAY_PRIORITY, useOverlayTurn } from '../overlayQueue';
import { NOTICES_POLL_MS, pickNotice, splitNoticeBody, withDismissed } from './noticePolicy';
import { noticesCopy } from './noticesCopy';
import '../floatingCards.css';
import './globalNotice.css';

/**
 * B-982: operator notices from the instance config (`GET /v1/notices`).
 * Asked for on mount, every 10 minutes and on web resume (`sync.onResume`,
 * AGENTS #13 — no listeners of its own). Shows the newest one not dismissed;
 * 「知道了」 records the id in synced settings so every device stops showing
 * it. A notice the operator marked not dismissible can only be closed for
 * this page load. A `notice` in the overlay queue: it waits while the release
 * notes are open and steps aside for anything above it.
 */
export function GlobalNotice() {
  const [notices, setNotices] = useState<NoticeView[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const dismissed = useSetting('dismissedNoticeIds');
  // Server settings loaded at least once — the defaults would show a dismissed notice for a moment.
  const settingsReady = storage((s) => s.settingsVersion !== null);
  const { open: changelogOpen } = useChangelogVisit();

  useEffect(() => {
    let gone = false;
    const load = () => {
      void fetchNotices().then((next) => {
        if (gone) return;
        setNow(Date.now());
        if (next) setNotices(next);
      });
    };
    load();
    const timer = window.setInterval(load, NOTICES_POLL_MS);
    const off = sync.onResume(load);
    return () => { gone = true; window.clearInterval(timer); off(); };
  }, []);

  const notice = settingsReady ? pickNotice(notices, dismissed, closed, now) : null;
  const turn = useOverlayTurn(notice !== null && !changelogOpen, OVERLAY_PRIORITY.notice);
  if (!turn || !notice) return null;

  const dismiss = () => {
    // The store, not this render's snapshot: another device may have added an id since.
    const current = storage.getState().settings.dismissedNoticeIds;
    sync.applySettings({ dismissedNoticeIds: withDismissed(current, notice.id) });
  };
  const closeForNow = () => setClosed((prev) => new Set(prev).add(notice.id));
  return <GlobalNoticeCard key={notice.id} notice={notice} onDismiss={dismiss} onClose={closeForNow} />;
}

export function GlobalNoticeCard({ notice, onDismiss, onClose }: { notice: NoticeView; onDismiss: () => void; onClose: () => void }) {
  const { lang } = useTranslation();
  const copy = noticesCopy(lang);
  const titleId = useId();
  const Icon = notice.level === 'warning' ? TriangleAlert : Info;
  return (
    <aside className="gn-card" data-level={notice.level} role="region" aria-live="polite" aria-labelledby={titleId} aria-roledescription={copy.region}>
      {!notice.dismissible && (
        <button className="gn-close" type="button" onClick={onClose} aria-label={copy.close} title={copy.close}><X size={18} /></button>
      )}
      <div className="gn-head">
        <Icon className="gn-icon" size={16} aria-hidden="true" />
        <h2 id={titleId}>{notice.title}</h2>
      </div>
      {notice.body && (
        <p className="gn-body">
          {splitNoticeBody(notice.body).map((part, i) => part.kind === 'link'
            ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.href}</a>
            : <span key={i}>{part.text}</span>)}
        </p>
      )}
      {notice.dismissible && (
        <div className="gn-actions">
          <button className="gn-dismiss" type="button" onClick={onDismiss}>{copy.gotIt}</button>
        </div>
      )}
    </aside>
  );
}
