/**
 * TodosScreen — /todos: a live window onto whatever todo system the user wired
 * up on a MACHINE (spec `specs/2026-08-todo-provider.md`). very-happy knows
 * nothing about the backend: it runs the user's `todoProvider` command over
 * machine RPC and renders what comes back.
 *
 * Four decisions this file exists to hold:
 *  1. **No polling, ever.** One fetch on entry + an explicit refresh button.
 *     The provider is a shell around somebody else's rate-limited API (spec
 *     risk 2); an auto-refresh loop would burn that budget silently. Do not add
 *     an interval here.
 *  2. **The provider is the truth.** `complete` results are not parsed, so a
 *     tick is optimistic ONLY until the mandatory re-list lands — success or
 *     failure (spec risk 4). The optimistic flag is cleared by the list, never
 *     by the complete call's own answer.
 *  3. **Which machine is always on screen** (spec risk 5): different machines
 *     carry different providers, so a header that merely implies the source
 *     would be a data-confusion bug.
 *  4. **Titles are untrusted text** (spec risk 3): they come from an external
 *     system. Plain text nodes only — no markdown, no HTML, no innerHTML.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Check, Plus, RefreshCw } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useTranslation } from '@/i18n/useTranslation';
import { LayoutList, SignalHigh } from 'lucide-react';
import { useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { machineTodoComplete, machineTodoCreate, machineTodoList, type TodoFailure, type TodoItem } from '@/sync/todoOps';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { EmptyState, OrbitLoader, Spinner, StatusDot, toast } from '@/ui';
import { isSetupNeeded, todoFailureText } from './todoFailureText';
import {
    completionReducer,
    displayStatus,
    emptyCompletion,
    groupTodoItems,
    hasOmissions,
    isCompleting,
    isFlat,
    normalizeNewTitle,
    pickTodoMachine,
    type TodoGroupBy,
} from './todosModel';
import './todos.css';

type LoadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; items: TodoItem[]; dropped: number; truncated: boolean }
    | { kind: 'failed'; failure: TodoFailure };

export function TodosScreen() {
    const { t } = useTranslation();
    const machines = useAllMachines({ includeOffline: true });
    const [storedMachineId, setStoredMachineId] = useLocalSettingMutable('todoMachineId');
    const [groupBy, setGroupBy] = useLocalSettingMutable('todoGroupBy');
    const machineId = pickTodoMachine(machines, storedMachineId);
    const machine = machines.find((m) => m.id === machineId) ?? null;
    const machineName = machine ? machineLabel(machine) : (machineId ?? '');

    const [state, setState] = useState<LoadState>({ kind: 'idle' });
    /** true while a refresh runs on top of an already-rendered list */
    const [busy, setBusy] = useState(false);
    const [completion, dispatchCompletion] = useReducer(completionReducer, emptyCompletion);
    const [draft, setDraft] = useState('');
    const [creating, setCreating] = useState(false);

    // Guards a switched machine / unmounted screen from being overwritten by a
    // reply to an older request (machineRPC can take up to 60s).
    const requestRef = useRef(0);

    const load = useCallback(
        async (targetId: string, opts?: { silent?: boolean }) => {
            const seq = ++requestRef.current;
            if (opts?.silent) {
                setBusy(true);
            } else {
                // also clears a spinner stranded by a silent load we superseded
                setBusy(false);
                setState({ kind: 'loading' });
            }
            const res = await machineTodoList(targetId);
            // A newer request (or a machine switch) owns the UI now — this
            // answer is stale, and the owner will clear `busy` itself.
            if (requestRef.current !== seq) return;
            setBusy(false);
            // The list IS the truth — every optimistic tick is resolved here,
            // whether the provider honoured it or not.
            dispatchCompletion({ type: 'refreshed' });
            if ('ok' in res && res.ok === false) {
                // Deliberate: a failed refresh replaces the (now unverifiable)
                // list instead of leaving a stale one on screen pretending to
                // be live. The failure card carries its own Retry.
                setState({ kind: 'failed', failure: res });
                return;
            }
            setState({ kind: 'ready', items: res.items, dropped: res.dropped, truncated: res.truncated });
        },
        [],
    );

    useEffect(() => {
        if (!machineId) {
            setState({ kind: 'idle' });
            return;
        }
        void load(machineId);
    }, [machineId, load]);

    const onComplete = async (item: TodoItem) => {
        if (!machineId) return;
        dispatchCompletion({ type: 'begin', id: item.id });
        const res = await machineTodoComplete(machineId, item.id);
        if ('ok' in res && res.ok === false) {
            dispatchCompletion({ type: 'rollback', id: item.id });
            toast.error(`${t('todos.completeFailed')} — ${todoFailureText(t, res)}`);
        }
        // Re-list either way (spec risk 4).
        await load(machineId, { silent: true });
    };

    const onCreate = async () => {
        const title = normalizeNewTitle(draft);
        if (!title || !machineId || creating) return;
        setCreating(true);
        const res = await machineTodoCreate(machineId, title);
        setCreating(false);
        if ('ok' in res && res.ok === false) {
            // Keep the draft — the user should not have to retype it.
            toast.error(`${t('todos.createFailed')} — ${todoFailureText(t, res)}`);
            return;
        }
        setDraft('');
        await load(machineId, { silent: true });
    };

    const refresh = () => {
        if (machineId) void load(machineId, { silent: state.kind === 'ready' });
    };

    return (
        <div className="td">
            <header className="td-header">
                <BackButton />
                <div className="td-title">{t('todos.title')}</div>
                {machineId && (
                    <div className="td-source" title={t('todos.machine')}>
                        <StatusDot status={machine && isMachineOnline(machine) ? 'connected' : 'offline'} size={8} />
                        {machines.length > 1 ? (
                            <select
                                className="td-select mono"
                                value={machineId}
                                aria-label={t('todos.machine')}
                                onChange={(e) => setStoredMachineId(e.target.value)}
                            >
                                {machines.map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {machineLabel(m)}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <span className="td-machine mono">{machineName}</span>
                        )}
                    </div>
                )}
                {/* 分组维度切换：'group'（provider 给的分组）↔ 'priority'（按优先级，
                    即「四象限」——滴答的四象限本质就是按优先级分桶）。两种是正交的
                    看法，都有用，所以给切换而不是二选一写死。 */}
                <button
                    type="button"
                    className="td-groupby"
                    onClick={() => setGroupBy(groupBy === 'group' ? 'priority' : 'group')}
                    aria-label={t('todos.groupBy')}
                    title={groupBy === 'group' ? t('todos.groupByPriorityHint') : t('todos.groupByGroupHint')}
                >
                    {groupBy === 'group' ? <LayoutList size={15} /> : <SignalHigh size={15} />}
                </button>
                <button
                    type="button"
                    className="td-refresh"
                    onClick={refresh}
                    disabled={!machineId || busy || state.kind === 'loading'}
                    aria-label={t('todos.refresh')}
                    title={t('todos.refresh')}
                >
                    {busy ? <Spinner size={14} /> : <RefreshCw size={15} />}
                </button>
            </header>

            <div className="td-body">
                {state.kind === 'idle' && (
                    <EmptyState compact title={t('todos.noMachines')} description={t('todos.noMachinesDescription')} />
                )}

                {state.kind === 'loading' && (
                    <div className="td-loading">
                        <OrbitLoader size="compact" label={t('todos.loading')} />
                    </div>
                )}

                {state.kind === 'failed' && (
                    <FailureCard failure={state.failure} machineName={machineName} onRetry={refresh} />
                )}

                {state.kind === 'ready' && (
                    <>
                        <form
                            className="td-compose"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void onCreate();
                            }}
                        >
                            <input
                                className="td-input"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder={t('todos.addPlaceholder')}
                                spellCheck={false}
                                disabled={creating}
                            />
                            <button
                                type="submit"
                                className="td-add"
                                disabled={creating || normalizeNewTitle(draft) === null}
                                aria-label={t('todos.add')}
                                title={t('todos.add')}
                            >
                                {creating ? <Spinner size={13} /> : <Plus size={15} />}
                            </button>
                        </form>

                        {hasOmissions(state.dropped, state.truncated) && (
                            <div className="td-omission" role="status">
                                {state.dropped > 0 && <span>{t('todos.omittedDropped', { count: state.dropped })}</span>}
                                {state.truncated && <span>{t('todos.omittedTruncated')}</span>}
                            </div>
                        )}

                        {state.items.length === 0 ? (
                            <div className="td-empty">{t('todos.empty')}</div>
                        ) : (
                            <TodoGroups items={state.items} completion={completion} onComplete={onComplete} groupBy={groupBy} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function TodoGroups({
    items,
    completion,
    onComplete,
    groupBy,
}: {
    items: TodoItem[];
    completion: { readonly pending: readonly string[] };
    onComplete: (item: TodoItem) => void;
    groupBy: TodoGroupBy;
}) {
    const { t } = useTranslation();
    const groups = groupTodoItems(items, groupBy);
    // 'priority' 模式恒有桶标题（四个桶是视图本体，没标题就没意义）
    const flat = groupBy === 'group' && isFlat(groups);
    return (
        <div className="td-groups">
            {groups.map((group) => (
                <section className="td-group" key={group.key ?? ' ungrouped'}>
                    {!flat && (
                        <h2 className="td-group-label">
                            {groupBy === 'priority'
                                ? t(`todos.bucket_${group.key ?? 'none'}` as 'todos.bucket_none')
                                : group.key ?? t('todos.ungrouped')}
                        </h2>
                    )}
                    <ul className="td-list">
                        {group.items.map((item) => (
                            <TodoRow key={item.id} item={item} completion={completion} onComplete={onComplete} />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function TodoRow({
    item,
    completion,
    onComplete,
}: {
    item: TodoItem;
    completion: { readonly pending: readonly string[] };
    onComplete: (item: TodoItem) => void;
}) {
    const { t } = useTranslation();
    const shown = displayStatus(item, completion);
    const pending = isCompleting(completion, item.id);
    const done = shown === 'done';
    const priority = item.priority && item.priority !== 'none' ? item.priority : null;
    const due = typeof item.due === 'string' && item.due.trim() !== '' ? item.due.trim() : null;
    const note = typeof item.note === 'string' && item.note.trim() !== '' ? item.note.trim() : null;

    return (
        <li className={`td-item${done ? ' is-done' : ''}${pending ? ' is-pending' : ''}`}>
            <button
                type="button"
                className="td-check"
                onClick={() => onComplete(item)}
                disabled={done}
                aria-label={done ? t('todos.done') : t('todos.markDone')}
                title={done ? t('todos.done') : t('todos.markDone')}
            >
                {done && <Check size={12} />}
            </button>
            <div className="td-main">
                {/* untrusted external text — rendered as a text node, never parsed */}
                <div className="td-item-title">{item.title}</div>
                {note && <div className="td-note">{note}</div>}
                <div className="td-meta">
                    {priority && (
                        <span className={`td-pri td-pri--${priority}`}>
                            {priority === 'high'
                                ? t('todos.priorityHigh')
                                : priority === 'medium'
                                    ? t('todos.priorityMedium')
                                    : t('todos.priorityLow')}
                        </span>
                    )}
                    {due && <span className="td-due mono">{t('todos.due', { due })}</span>}
                    <span className="td-id mono">{item.id}</span>
                </div>
            </div>
        </li>
    );
}

/**
 * The failure surface. `not-configured` is the odd one out: nothing is broken,
 * the feature is simply not switched on for that machine — so it gets setup
 * guidance (where the file lives, where the contract is written down, which
 * example to copy) rather than an error.
 */
function FailureCard({
    failure,
    machineName,
    onRetry,
}: {
    failure: TodoFailure;
    machineName: string;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    if (isSetupNeeded(failure)) {
        return (
            <div className="td-setup">
                <div className="td-setup-title">{t('todos.notConfiguredTitle')}</div>
                <p className="td-setup-body">{t('todos.notConfiguredBody', { machine: machineName })}</p>
                <p className="td-setup-body">
                    <a
                        href="https://github.com/Mereithhh/very-happy/blob/main/docs/channels.md#inbound-todo-provider-external-task-lists-in-the-web-ui"
                        target="_blank"
                        rel="noreferrer"
                    >
                        {t('todos.notConfiguredDocs')}
                    </a>
                </p>
                <pre className="td-setup-body td-setup-example mono">{'{\n  "todoProvider": {\n    "command": "/absolute/path/to/provider",\n    "args": []\n  }\n}'}</pre>
                <p className="td-setup-body td-setup-example mono">{t('todos.notConfiguredExample')}</p>
            </div>
        );
    }
    return (
        <div className="td-failure" role="alert">
            <div className="td-failure-text">{todoFailureText(t, failure)}</div>
            <button type="button" className="td-retry" onClick={onRetry}>
                {t('todos.retry')}
            </button>
        </div>
    );
}
