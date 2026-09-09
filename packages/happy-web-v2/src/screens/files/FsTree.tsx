import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, Search, Link as LinkIcon } from 'lucide-react';
import { machineFsList, type FsEntry, type FsFailure } from '@/sync/fsOps';
import { useTranslation } from '@/i18n/useTranslation';
import { joinFsPath, sortFsEntries, visibleFsEntries, type FsSortMode } from './fsBrowseModel';
import { fsFailureText } from './fsFailureText';

type Directory = { entries: FsEntry[]; truncated: boolean } | { failure: FsFailure };
/** Only expanded directories are fetched. Filtering never pretends to search unloaded folders. */
export function FsTree({ machineId, path, entries, showHidden, sortMode, selected, onFile, onDirectory }: {
    machineId: string; path: string; entries: FsEntry[]; showHidden: boolean; sortMode: FsSortMode;
    selected: string | null; onFile: (path: string) => void; onDirectory: (path: string) => void;
}) {
    const { t, lang } = useTranslation();
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [cache, setCache] = useState<Record<string, Directory>>({});
    const pending = useRef(new Set<string>());
    const generation = useRef(0);
    useEffect(() => () => { generation.current++; }, []);
    const filter = query.trim().toLocaleLowerCase();
    const matches = (entry: FsEntry, parent: string): boolean => {
        if (!filter || entry.name.toLocaleLowerCase().includes(filter)) return true;
        const sub = cache[joinFsPath(parent, entry.name)];
        return !!sub && 'entries' in sub && visibleFsEntries(sub.entries, showHidden).some(child => matches(child, joinFsPath(parent, entry.name)));
    };
    async function toggle(target: string) {
        if (expanded.has(target)) { setExpanded(old => { const next = new Set(old); next.delete(target); return next; }); return; }
        setExpanded(old => new Set(old).add(target));
        if (cache[target] || pending.current.has(target)) return;
        pending.current.add(target);
        const current = generation.current;
        const result = await machineFsList(machineId, target);
        pending.current.delete(target);
        if (generation.current !== current) return;
        if (!result.ok && result.code === 'not-a-directory') { setExpanded(old => { const next = new Set(old); next.delete(target); return next; }); onFile(target); return; }
        setCache(old => ({ ...old, [target]: result.ok ? { entries: result.entries, truncated: result.truncated } : { failure: result } }));
    }
    function rows(items: FsEntry[], parent: string, depth: number): React.ReactNode {
        return visibleFsEntries(sortFsEntries(items, sortMode), showHidden).filter(entry => matches(entry, parent)).map(entry => {
            const target = joinFsPath(parent, entry.name);
            const dir = entry.type !== 'file';
            const open = expanded.has(target) || !!filter;
            const loaded = cache[target];
            return <div key={target}>
                <button type="button" className={`fsb-row fsb-tree-row${selected === target ? ' is-selected' : ''}`}
                    style={{ paddingInlineStart: `${12 + Math.min(depth, 12) * 14}px` }} title={target}
                    aria-expanded={dir ? open : undefined}
                    onClick={() => dir ? void toggle(target) : onFile(target)}
                    onDoubleClick={() => { if (dir) onDirectory(target); }}>
                    {dir ? open ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="fsb-tree-spacer"/>}
                    {entry.type === 'symlink' ? <LinkIcon size={14}/> : dir ? <Folder size={14}/> : <FileText size={14}/>}
                    <span className="fsb-name">{entry.name}</span>
                </button>
                {dir && open && loaded && ('failure' in loaded ? <div className="fsb-notice" role="status">{fsFailureText(t, loaded.failure)}<button onClick={() => { setCache(old => { const next = {...old}; delete next[target]; return next; }); setExpanded(old => { const next = new Set(old); next.delete(target); return next; }); }}>{t('fsBrowser.retry')}</button></div> : <>
                    {rows(loaded.entries, target, depth + 1)}
                    {loaded.truncated && <div className="fsb-notice">{t('fsBrowser.listTruncated', {count:2000})}</div>}
                </>)}
                {dir && open && !loaded && !filter && <div className="fsb-notice">{t('common.loading')}</div>}
            </div>;
        });
    }
    const filterLabel = lang.startsWith('zh') ? '筛选已加载的文件…' : 'Filter loaded files…';
    return <div className="fsb-tree">
        <label className="fsb-filter"><Search size={14}/><input aria-label={filterLabel} placeholder={filterLabel} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="fsb-tree-list">{rows(entries, path, 0)}</div>
    </div>;
}
