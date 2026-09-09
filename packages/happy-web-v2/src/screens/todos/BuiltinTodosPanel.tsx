import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { TodoAgentSetup } from './TodoAgentSetup';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { useTranslation } from '@/i18n/useTranslation';
import { apiSocket } from '@/sync/apiSocket';
import { sync } from '@/sync/sync';
import { onKvChanges } from '@/sync/kvUpdates';
import { BUILTIN_TODO_PREFIX, TITLE_MAX_LENGTH, NOTE_MAX_LENGTH, BuiltinTodoError, createBuiltinTodoClient, sortBuiltinTodos, type BuiltinTodoRecord } from '@/sync/builtinTodos';

export function BuiltinTodosPanel({ credentials }: { credentials: AuthCredentials }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const words = (cn: string, en: string) => zh ? cn : en;
    const client = useMemo(() => createBuiltinTodoClient(credentials), [credentials.token, credentials.secret]);
    const [records, setRecords] = useState<BuiltinTodoRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [limited, setLimited] = useState(false);
    const [invalid, setInvalid] = useState(0);
    const [draft, setDraft] = useState('');
    const [showDone, setShowDone] = useState(false);
    const [editing, setEditing] = useState<BuiltinTodoRecord | null>(null);
    const [title, setTitle] = useState('');
    const [note, setNote] = useState('');
    const [deleting, setDeleting] = useState<string | null>(null);
    const alive = useRef(true);
    const request = useRef(0);
    const writing = useRef(false);

    const describeError = useCallback((e: unknown) => {
        if (e instanceof BuiltinTodoError && e.code === 'limit') return zh ? '待办数量或内容达到上限，请整理任务或缩短内容后重试。' : 'Task or content limit reached. Remove old tasks or shorten the content.';
        if (e instanceof BuiltinTodoError && e.code === 'conflict') return zh
            ? '任务已在其他设备修改或删除。已重新读取，请核对后重试；编辑内容仍保留。'
            : 'This task changed on another device. Review the refreshed list and retry. Your draft is kept.';
        if (e instanceof BuiltinTodoError && (e.code === 'network' || e.code === 'timeout')) return zh
            ? '连接中断，结果尚未确认。请刷新核对任务后再操作，避免重复新增。'
            : 'Connection interrupted; the result is unconfirmed. Refresh and check before adding again.';
        if (e instanceof BuiltinTodoError && e.code === 'order-collision') return zh ? '这几条任务的排序值发生冲突，暂时无法调整。任务内容已保留。' : 'These tasks have conflicting order values and cannot be reordered yet. Their content is safe.';
        return zh ? '请求失败，请刷新核对后重试。未保存的输入会保留。' : 'Request failed. Refresh and check before retrying. Unsaved drafts are kept.';
    }, [zh]);

    const refresh = useCallback(async () => {
        const seq = ++request.current;
        setLoading(true);
        try {
            const result = await client.list();
            if (!alive.current || seq !== request.current) return;
            setRecords(sortBuiltinTodos(result.records));
            setLimited(result.truncated);
            setInvalid(result.invalidCount);
            setLoaded(true);
        } catch (e) {
            if (alive.current && seq === request.current) setError(describeError(e));
        } finally {
            if (alive.current && seq === request.current) setLoading(false);
        }
    }, [client, describeError]);

    useEffect(() => {
        alive.current = true;
        void refresh();
        const changed = () => { if (!writing.current) void refresh(); };
        const disposeKv = onKvChanges(changes => { if (changes.some(c => c.key.startsWith(BUILTIN_TODO_PREFIX))) changed(); });
        const disposeResume = sync.onResume(changed);
        const disposeReconnect = apiSocket.onReconnected(changed);
        const disposeRecovered = apiSocket.onRecovered(changed);
        return () => { alive.current = false; request.current++; disposeKv(); disposeResume(); disposeReconnect(); disposeRecovered(); };
    }, [refresh]);

    const run = async (operation: () => Promise<unknown>, success?: () => void) => {
        if (writing.current) return;
        writing.current = true;
        ++request.current; // A list started before this write cannot roll it back.
        setBusy(true);
        setError('');
        try {
            const result = await operation();
            if (!alive.current) return;
            // Show confirmed writes even if the following read is unavailable.
            const confirmed = Array.isArray(result) ? result : result && typeof result === 'object' && 'id' in result ? [result] : [];
            if (confirmed.length) setRecords(current => sortBuiltinTodos([...current.filter(r => !confirmed.some(c => c.id === r.id)), ...confirmed as BuiltinTodoRecord[]]));
            success?.();
        } catch (e) {
            if (alive.current) setError(describeError(e));
        } finally {
            writing.current = false;
            if (alive.current) { setBusy(false); await refresh(); }
        }
    };
    const visible = records.filter(r => showDone ? r.status === 'done' : r.status === 'open');
    const completed = records.filter(r => r.status === 'done').length;
    const startEdit = (record: BuiltinTodoRecord) => { setEditing(record); setTitle(record.title); setNote(record.note); setDeleting(null); };

    return <div className="td-body td-builtin">
        <div className="td-intro">
            <p>{words('随手记下，跟随账号同步。不需要连接电脑。', 'Capture a task. Sync with your account. No connected computer needed.')}</p>
            <button className="td-action" type="button" aria-label={words('刷新待办', 'Refresh todos')} disabled={busy || loading} onClick={() => { setError(''); void refresh(); }}><RefreshCw size={16} /></button>
        </div>
        <TodoAgentSetup />
        {error && <div className="td-failure" role="alert"><span>{error}</span></div>}
        {(limited || invalid > 0) && <div className="td-omission" role="status">{words('部分任务无法完整读取，已暂停新增和排序。请检查数据或更新客户端。', 'Some tasks could not be fully read. Adding and reordering are paused; check your data or update the client.')}</div>}
        <form className="td-compose" onSubmit={e => { e.preventDefault(); if (draft.trim()) void run(() => client.create(draft.trim()), () => setDraft('')); }}>
            <input className="td-input" aria-label={words('新待办', 'New todo')} placeholder={words('记下一件要做的事…', 'What needs to be done?')} maxLength={TITLE_MAX_LENGTH} value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} />
            <button type="submit" className="td-primary" disabled={!loaded || busy || limited || invalid > 0 || !draft.trim()} aria-label={words('新增待办', 'Add todo')}><Plus size={18} /></button>
        </form>
        <div className="td-filters">
            <button type="button" aria-pressed={!showDone} onClick={() => setShowDone(false)}>{words('待处理', 'Open')} · {records.length - completed}</button>
            <button type="button" aria-pressed={showDone} onClick={() => setShowDone(true)}>{words('已完成', 'Completed')} · {completed}</button>
            {loading && <span role="status">{words('同步中…', 'Syncing…')}</span>}
        </div>
        {editing && <form className="td-editor" onSubmit={e => {
            e.preventDefault();
            void run(() => client.update(editing, { title: title.trim(), note }), () => setEditing(null));
        }}>
            <label>{words('标题', 'Title')}<input autoFocus className="td-input" value={title} maxLength={TITLE_MAX_LENGTH} onChange={e => setTitle(e.target.value)} disabled={busy} /></label>
            <label>{words('备注', 'Notes')}<textarea className="td-input" value={note} maxLength={NOTE_MAX_LENGTH} onChange={e => setNote(e.target.value)} disabled={busy} rows={4} /></label>
            {records.find(r => r.id === editing.id)?.version !== editing.version && <div className="td-conflict" role="status">
                <p>{words('这条任务已在其他设备变化。你的输入仍保留，请核对最新内容。', 'This task changed on another device. Your draft is kept; review the latest content.')}</p>
                {records.find(r => r.id === editing.id) ? <>
                    <p>{words('最新标题：', 'Latest title: ')}{records.find(r => r.id === editing.id)?.title}</p>
                    <p>{words('最新备注：', 'Latest notes: ')}{records.find(r => r.id === editing.id)?.note}</p>
                    <button type="button" className="td-action" disabled={busy} onClick={() => setEditing(records.find(r => r.id === editing.id) ?? null)}>{words('保留我的输入，基于最新版本继续', 'Keep my draft and use the latest version')}</button>
                </> : <p>{words('该任务已删除。请复制需要保留的内容。', 'This task was deleted. Copy any draft text you want to keep.')}</p>}
            </div>}
            <div className="td-editor-actions">
                <button className="td-primary" type="submit" disabled={busy || !title.trim() || records.find(r => r.id === editing.id)?.version !== editing.version}>{words('保存', 'Save')}</button>
                <button className="td-action" type="button" disabled={busy} onClick={() => setEditing(null)}>{words('取消', 'Cancel')}</button>
            </div>
        </form>}
        {loaded && visible.length === 0 && <div className="td-empty">{showDone ? words('还没有已完成的任务。', 'No completed tasks yet.') : words('这里很清爽。先记下你的第一件事。', 'A clear list. Add your first task above.')}</div>}
        {visible.length > 0 && <ul className="td-list">
            {visible.map((record, index) => <li key={record.id} className={`td-item td-builtin-row${record.status === 'done' ? ' is-done' : ''}`}>
                <button className="td-action td-toggle" type="button" disabled={busy} aria-label={`${record.status === 'done' ? words('恢复', 'Reopen') : words('完成', 'Complete')}: ${record.title}`} onClick={() => void run(() => client.update(record, { status: record.status === 'done' ? 'open' : 'done' }))}><span>{record.status === 'done' && <Check size={14} />}</span></button>
                <div className="td-main">
                    <div className="td-item-title">{record.title}</div>
                    {record.note && <div className="td-note">{record.note}</div>}
                    <div className="td-row-actions">
                        <button className="td-action" type="button" disabled={busy} aria-label={`${words('编辑', 'Edit')}: ${record.title}`} onClick={() => startEdit(record)}><Pencil size={15} /></button>
                        {!showDone && <>
                            <button className="td-action" type="button" disabled={busy || limited || invalid > 0 || index === 0} aria-label={`${words('上移', 'Move up')}: ${record.title}`} onClick={() => void run(() => client.move(record, visible[index - 1]))}><ArrowUp size={15} /></button>
                            <button className="td-action" type="button" disabled={busy || limited || invalid > 0 || index === visible.length - 1} aria-label={`${words('下移', 'Move down')}: ${record.title}`} onClick={() => void run(() => client.move(record, visible[index + 1]))}><ArrowDown size={15} /></button>
                        </>}
                        <button className="td-action" type="button" disabled={busy} aria-label={`${words('删除', 'Delete')}: ${record.title}`} onClick={() => setDeleting(record.id)}><Trash2 size={15} /></button>
                    </div>
                    {deleting === record.id && <div className="td-delete-confirm">
                        <span>{words('删除这条待办？', 'Delete this todo?')}</span>
                        <button className="td-action" type="button" disabled={busy} onClick={() => void run(() => client.remove(record), () => { setRecords(current => current.filter(r => r.id !== record.id)); setDeleting(null); if (editing?.id === record.id) setEditing(null); })}>{words('确认删除', 'Confirm delete')}</button>
                        <button className="td-action" type="button" disabled={busy} onClick={() => setDeleting(null)}>{words('取消', 'Cancel')}</button>
                    </div>}
                </div>
            </li>)}
        </ul>}
    </div>;
}
