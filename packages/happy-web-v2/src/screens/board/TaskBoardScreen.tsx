/**
 * TaskBoardScreen — the global "what is every agent doing" board. A pure
 * derived view over state the app already syncs (see boardItems.ts).
 *
 * Two layouts (device-local `localSettings.boardLayout` toggle in the header):
 *  - 'status' (V1): three columns — attention / working / idle+ended.
 *  - 'tasks'  (V2): one swimlane per open board task (KV `vh.board-tasks.v1`),
 *    plus an Ungrouped lane for terminals and unclassified sessions. Inside a
 *    lane items keep the SAME status order as the columns view (attention
 *    first) — one sort rule across both layouts, per the V2 plan's "泳道内
 *    保留状态排序" option.
 *
 * "New task" creates a KV task; a lane's "Dispatch" opens the existing
 * NewSessionModal with the task description prefilled as the first message,
 * and records the spawned sessionId on the task (manual mapping — the LLM's
 * metadata.board.taskId only claims sessions no task claims manually).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, Plus, Rocket, Trash2 } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useLocalSettingMutable } from '@/sync/storage';
import { useBoardTasks, type BoardTask } from '@/sync/boardTasks';
import { planOrderWrites, visibleTasks } from '@/sync/boardTaskOps';
import { Modal } from '@/modal';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import { useBoardItems } from './useBoardItems';
import { BoardCard } from './BoardCard';
import { groupBoardItems, type BoardItem } from './boardItems';
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

/** Minimal title+description form for creating a board task. */
function NewTaskModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const createTask = useBoardTasks((s) => s.create);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const canCreate = title.trim().length > 0;

  function onCreate() {
    if (!canCreate) return;
    createTask(title, description);
    onClose();
  }

  return (
    <div className="bd-modal-backdrop" onClick={onClose}>
      <div className="bd-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{t('board.newTask')}</div>
        <input
          className="bd-modal-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('board.taskTitlePlaceholder') as string}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCreate(); }
          }}
        />
        <textarea
          className="bd-modal-input bd-modal-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('board.taskDescriptionPlaceholder') as string}
          rows={3}
        />
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="bd-btn bd-btn--primary" disabled={!canCreate} onClick={onCreate}>
            {t('board.createTask')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskLane({
  task,
  items,
  now,
  dragging,
  onDispatch,
  onHeadPointerDown,
}: {
  task: BoardTask;
  items: BoardItem[];
  now: number;
  /** this lane is the one being dragged right now */
  dragging?: boolean;
  onDispatch: (task: BoardTask) => void;
  /** lane-header drag handle (fine pointers; no-op on touch) */
  onHeadPointerDown?: (e: React.PointerEvent, taskId: string) => void;
}) {
  const { t } = useTranslation();
  const setStatus = useBoardTasks((s) => s.setStatus);
  const remove = useBoardTasks((s) => s.remove);

  async function onDelete() {
    const ok = await Modal.confirm(
      t('board.deleteTask') as string,
      t('board.deleteTaskConfirm', { title: task.title }) as string,
      { destructive: true },
    );
    if (ok) remove(task.id);
  }

  return (
    <section className={`bd-lane${dragging ? ' is-drag' : ''}`} data-laneid={task.id}>
      <header
        className="bd-lane-head"
        onPointerDown={onHeadPointerDown ? (e) => onHeadPointerDown(e, task.id) : undefined}
      >
        <div className="bd-lane-titles">
          <span className="bd-lane-title">{task.title}</span>
          {task.description && <span className="bd-lane-desc">{task.description}</span>}
        </div>
        <span className="bd-col-count mono">{items.length}</span>
        <div className="bd-lane-actions">
          <button
            type="button"
            className="bd-btn bd-btn--primary"
            title={t('board.dispatch') as string}
            onClick={() => onDispatch(task)}
          >
            <Rocket size={13} /> {t('board.dispatch')}
          </button>
          <button
            type="button"
            className="bd-btn"
            title={t('board.markDone') as string}
            onClick={() => setStatus(task.id, 'done')}
          >
            <Check size={13} />
          </button>
          <button type="button" className="bd-btn" title={t('board.deleteTask') as string} onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>
      </header>
      <div className="bd-lane-cards">
        {items.length === 0 ? (
          <div className="bd-col-empty">{t('board.emptyLane')}</div>
        ) : (
          items.map((item) => <BoardCard key={item.key} item={item} now={now} />)
        )}
      </div>
    </section>
  );
}

export function TaskBoardScreen() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const items = useBoardItems();
  const [layout, setLayout] = useLocalSettingMutable('boardLayout');
  const tasks = useBoardTasks((s) => s.tasks);
  const initializeTasks = useBoardTasks((s) => s.initialize);
  const attachSession = useBoardTasks((s) => s.attachSession);
  const [showNewTask, setShowNewTask] = useState(false);
  const [dispatchTask, setDispatchTask] = useState<BoardTask | null>(null);

  // Pull the server-backed task list once per board mount (merges into the
  // local cache; cheap — a single KV GET).
  useEffect(() => {
    void initializeTasks();
  }, [initializeTasks]);

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

  const grouped = useMemo(
    () => (layout === 'tasks' ? groupBoardItems(items, visibleTasks(tasks)) : null),
    [layout, items, tasks],
  );

  // ----- lane drag-reorder (fine pointers; coarse pointers use the lane
  // menu's move up/down instead). Same hand-rolled pointer-event school as
  // the sidebar's pinned section: 6px activation threshold, midpoint
  // insertion measured from the live DOM, optimistic order in state while
  // the drag is live, ONE store write on drop (planOrderWrites → usually a
  // single task's fractional key).
  const applyOrders = useBoardTasks((s) => s.applyOrders);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const [laneDragId, setLaneDragId] = useState<string | null>(null);
  const [laneDragIds, setLaneDragIds] = useState<string[] | null>(null);
  const laneDragIdsRef = useRef<string[] | null>(null);

  const displayLanes = useMemo(() => {
    if (!grouped) return null;
    if (!laneDragIds) return grouped.lanes;
    const byId = new Map(grouped.lanes.map((l) => [l.task.id, l]));
    return laneDragIds.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
  }, [grouped, laneDragIds]);

  const onLaneHeadPointerDown = (e: React.PointerEvent, taskId: string) => {
    if (e.button !== 0) return;
    const lanes = grouped?.lanes ?? [];
    if (lanes.length < 2) return;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) return;
    // buttons / menus inside the header are not drag handles
    if ((e.target as HTMLElement).closest('button, [role="menu"]')) return;
    const startY = e.clientY;
    const state = { active: false };
    const startOrder = lanes.map((l) => l.task.id);
    const taskById = new Map(lanes.map((l) => [l.task.id, l.task]));
    const onMove = (ev: PointerEvent) => {
      if (!state.active) {
        if (Math.abs(ev.clientY - startY) < 6) return;
        state.active = true;
        laneDragIdsRef.current = startOrder.slice();
        setLaneDragId(taskId);
        setLaneDragIds(laneDragIdsRef.current);
      }
      ev.preventDefault();
      const sect = lanesRef.current;
      const cur = laneDragIdsRef.current;
      if (!sect || !cur) return;
      const from = cur.indexOf(taskId);
      if (from < 0) return;
      // Insertion index = how many OTHER lanes have their midpoint above the
      // pointer (live DOM renders `cur`'s order; the ungrouped lane carries
      // no data-laneid and stays pinned at the tail).
      let target = 0;
      for (const el of Array.from(sect.querySelectorAll<HTMLElement>('[data-laneid]'))) {
        if (el.dataset.laneid === taskId) continue;
        const r = el.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) target++;
      }
      if (target !== from) {
        const next = cur.slice();
        next.splice(from, 1);
        next.splice(target, 0, taskId);
        laneDragIdsRef.current = next;
        setLaneDragIds(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const finalIds = laneDragIdsRef.current;
      laneDragIdsRef.current = null;
      setLaneDragId(null);
      setLaneDragIds(null);
      if (!state.active || !finalIds) return;
      // The release may land on a header button — swallow the click it would
      // produce so a drag never doubles as "dispatch"/"mark done".
      const swallow = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true } as any), 150);
      if (finalIds.join('\n') === startOrder.join('\n')) return; // dropped back in place
      const seq = finalIds
        .map((id) => taskById.get(id))
        .filter((t): t is BoardTask => !!t);
      applyOrders(planOrderWrites(seq, taskId));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

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
        <div className="bd-header-tools">
          <div className="bd-layout-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={layout === 'status'}
              className={`bd-toggle-btn${layout === 'status' ? ' is-on' : ''}`}
              onClick={() => setLayout('status')}
            >
              {t('board.layoutStatus')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={layout === 'tasks'}
              className={`bd-toggle-btn${layout === 'tasks' ? ' is-on' : ''}`}
              onClick={() => setLayout('tasks')}
            >
              {t('board.layoutTasks')}
            </button>
          </div>
          {layout === 'tasks' && (
            <button type="button" className="bd-btn bd-btn--primary" onClick={() => setShowNewTask(true)}>
              <Plus size={13} /> {t('board.newTask')}
            </button>
          )}
        </div>
      </header>

      {layout !== 'tasks' ? (
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
      ) : (
        <div className={`bd-lanes${laneDragId ? ' is-dragging' : ''}`} ref={lanesRef}>
          {grouped!.lanes.length === 0 && (
            <div className="bd-col-empty bd-lanes-empty">{t('board.noTasks')}</div>
          )}
          {displayLanes!.map((lane) => (
            <TaskLane
              key={lane.task.id}
              task={lane.task}
              items={lane.items}
              now={now}
              dragging={laneDragId === lane.task.id}
              onDispatch={setDispatchTask}
              onHeadPointerDown={onLaneHeadPointerDown}
            />
          ))}
          <section className="bd-lane bd-lane--ungrouped">
            <header className="bd-lane-head">
              <div className="bd-lane-titles">
                <span className="bd-lane-title bd-lane-title--dim">{t('board.ungrouped')}</span>
              </div>
              <span className="bd-col-count mono">{grouped!.ungrouped.length}</span>
            </header>
            <div className="bd-lane-cards">
              {grouped!.ungrouped.length === 0 ? (
                <div className="bd-col-empty">{t('board.emptyLane')}</div>
              ) : (
                grouped!.ungrouped.map((item) => <BoardCard key={item.key} item={item} now={now} />)
              )}
            </div>
          </section>
        </div>
      )}

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} />}
      {dispatchTask && (
        <NewSessionModal
          onClose={() => setDispatchTask(null)}
          initialCommandDefault={dispatchTask.description || dispatchTask.title}
          onSpawned={(sessionId) => attachSession(dispatchTask.id, sessionId)}
        />
      )}
    </div>
  );
}
