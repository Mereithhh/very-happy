/**
 * TaskBoardScreen — the global "what is every agent doing" board. A pure
 * derived view over state the app already syncs (see boardItems.ts): three
 * columns on desktop (attention / working / idle+ended), one stacked column
 * on mobile. Rendered inside the detail pane (`/board`), or at `/` when
 * localSettings.homeView === 'board'.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useBoardItems } from './useBoardItems';
import { BoardCard } from './BoardCard';
import type { BoardItem } from './boardItems';
import './board.css';

function Column({
  label,
  count,
  items,
  empty,
  now,
  tone,
  footer,
}: {
  label: string;
  count: number;
  items: BoardItem[];
  empty: string;
  now: number;
  tone?: 'attention';
  footer?: React.ReactNode;
}) {
  return (
    <section className={`bd-col${tone ? ` bd-col--${tone}` : ''}`}>
      <header className="bd-col-head">
        <span className="bd-col-label eyebrow">{label}</span>
        <span className="bd-col-count mono">{count}</span>
      </header>
      <div className="bd-col-list">
        {items.length === 0 ? (
          <div className="bd-col-empty">{empty}</div>
        ) : (
          items.map((item) => <BoardCard key={item.key} item={item} now={now} />)
        )}
        {footer}
      </div>
    </section>
  );
}

export function TaskBoardScreen() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const items = useBoardItems();

  // "waiting Xm" labels tick between store updates
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const attention = items.filter((i) => i.status === 'attention');
  const working = items.filter((i) => i.status === 'working');
  const idle = items.filter((i) => i.status === 'idle');
  const ended = items.filter((i) => i.status === 'ended');

  return (
    <div className="bd">
      <header className="bd-header">
        <button type="button" className="bd-back" onClick={() => navigate('/')} aria-label="Back">
          <ChevronLeft size={18} />
        </button>
        <span className="bd-title">{t('board.title')}</span>
        {attention.length > 0 && (
          <span className="bd-summary-attn mono" title={t('board.attention') as string}>
            {attention.length}
          </span>
        )}
      </header>
      <div className="bd-cols">
        <Column
          label={t('board.attention') as string}
          count={attention.length}
          items={attention}
          empty={t('board.emptyAttention') as string}
          now={now}
          tone="attention"
        />
        <Column
          label={t('board.working') as string}
          count={working.length}
          items={working}
          empty={t('board.emptyWorking') as string}
          now={now}
        />
        <Column
          label={t('board.idleEnded') as string}
          count={idle.length + ended.length}
          items={[...idle, ...ended]}
          empty={t('board.emptyIdle') as string}
          now={now}
          footer={
            <button type="button" className="bd-archived-link mono" onClick={() => navigate('/')}>
              {t('board.viewArchived')}
            </button>
          }
        />
      </div>
    </div>
  );
}
