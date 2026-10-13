/** DEV-only visual harness for B-565 fallbacks and the B-566 undo toast.
 *  /dev/robustness?theme=dark — renders REAL MessageView rows (one malformed),
 *  a panel-level boundary, and fires the real undo toast. */
import { useEffect, useState, type ReactNode } from 'react';
import type { Message } from '@/sync/typesMessage';
import { MessageView } from '@/screens/session/MessageView';
import { RecoverableBoundary } from '@/ui/RecoverableBoundary';
import { t } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import '@/screens/session/session.css';

const now = Date.now();
const msg = (id: string, text: unknown): Message => ({ kind: 'agent-text', id, localId: null, createdAt: now, text } as unknown as Message);

function Crash(): ReactNode { throw new TypeError('harness: deliberately broken panel'); }

export function RobustnessHarness() {
  const theme = new URLSearchParams(window.location.search).get('theme') ?? 'light';
  const [fixed, setFixed] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const showUndo = () => toast.undoable(t('robustness.archived'), t('robustness.undo'), () => toast.show('undone'), 60_000);
  useEffect(() => { showUndo(); }, []);
  const rows = [
    msg('m1', 'First message renders normally. 第一条消息正常渲染。'),
    fixed ? msg('m2', 'Second message, fixed by a rebuilt object.') : msg('m2', { malformed: true }),
    msg('m3', 'Third message also renders — the crash stayed in its row.'),
  ];
  return (
        <div style={{ minHeight: '100vh', background: 'var(--bg-0)', color: 'var(--text)', padding: 16, display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" data-testid="fix" onClick={() => setFixed(true)}>fix m2</button>
            <button type="button" data-testid="undo-toast" onClick={showUndo}>show undo toast</button>
          </div>
          <div className="cl-inner" style={{ maxWidth: 760 }}>
            {rows.map((m) => <MessageView key={m.id} message={m} sessionId="harness" showMeta={false} />)}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, minHeight: 200, maxWidth: 420 }}>
            <RecoverableBoundary region="workspace-pane"><Crash /></RecoverableBoundary>
          </div>
        </div>
  );
}
