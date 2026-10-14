import { useEffect, useState } from 'react';
import { ClipboardList, Copy, FileSearch } from 'lucide-react';
import { ToolHistoryEntries } from './ToolHistory';
import { useToolHistory } from '@/sync/useToolHistory';
import { countToolHistory, mergeToolHistory, transcriptClipboardHistory } from '@/sync/toolHistory';
import { useSession, useSessionMessages } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { openClipboardHistory } from '@/screens/clipboard/ClipboardHistoryPanel';
import { sessionPreviewPaths, legacyPreviewHistory } from './previewTools';
import type { SessionHistoryTab } from './sessionPanelState';
import './toolHistory.css';

/** Pushed records merged with transcript calls. Closing a preview never removes its entry. */
function useSessionToolHistory(sessionId: string) {
    const {messages} = useSessionMessages(sessionId);
    const session = useSession(sessionId);
    const {entries, failed, retry} = useToolHistory({sessionId});
    const cacheKey = `vh:session-previews:${sessionId}`;
    const [saved, setSaved] = useState<string[]>(() => {
        try {
            const value: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
            return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0')) : [];
        } catch { return []; }
    });
    const paths = [...new Set([...sessionPreviewPaths(messages), ...saved])];
    const serialized = JSON.stringify(paths);
    useEffect(() => {
        setSaved(previous => JSON.stringify(previous) === serialized ? previous : JSON.parse(serialized));
        try { localStorage.setItem(cacheKey, serialized); } catch { /* Transcript entries remain usable when browser storage is unavailable. */ }
    }, [cacheKey, serialized]);
    return {
        entries: mergeToolHistory(entries, [
            ...transcriptClipboardHistory(messages),
            ...legacyPreviewHistory(paths, session?.metadata?.path),
        ]),
        failed, retry, machineId: session?.metadata?.machineId,
    };
}

/**
 * B-602: the composer dock is one compact row of counts. Each chip opens its
 * record in the session aside (desktop: beside the chat; narrow: the full-screen
 * workspace panel) instead of expanding a long list above the composer.
 */
export function SessionPreviews({ sessionId, active, onToggle }: {
    sessionId: string; active: SessionHistoryTab | null; onToggle: (tab: SessionHistoryTab) => void;
}) {
    return <HistoryDock key={sessionId} sessionId={sessionId} active={active} onToggle={onToggle} />;
}

function HistoryDock({ sessionId, active, onToggle }: {
    sessionId: string; active: SessionHistoryTab | null; onToggle: (tab: SessionHistoryTab) => void;
}) {
    const { t } = useTranslation();
    const { entries } = useSessionToolHistory(sessionId);
    const counts = countToolHistory(entries);
    if (!counts.preview && !counts.clipboard) return null;
    const chip = (tab: SessionHistoryTab, count: number) => {
        const Icon = tab === 'previews' ? FileSearch : Copy;
        const label = t(tab === 'previews' ? 'toolHistory.previews' : 'toolHistory.clipboard');
        return <button type="button" className="tool-history-chip" aria-pressed={active === tab}
            title={t(active === tab ? 'toolHistory.closePanel' : 'toolHistory.openPanel', { name: label })}
            onClick={() => onToggle(tab)}>
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
            <span className="tool-history-chip-count">{count}</span>
        </button>;
    };
    return <nav className="tool-history-dock" aria-label={t('toolHistory.dockLabel')}>
        {counts.preview > 0 && chip('previews', counts.preview)}
        {counts.clipboard > 0 && chip('clipboard', counts.clipboard)}
    </nav>;
}

/** One workspace tab per kind (the aside keeps a single tab strip). */
export function SessionHistoryPanel({ sessionId, kind }: { sessionId: string; kind: SessionHistoryTab }) {
    const { t } = useTranslation();
    const { entries, failed, retry, machineId } = useSessionToolHistory(sessionId);
    const wanted = kind === 'previews' ? 'preview' : 'clipboard';
    return <div className="tool-history tool-history--panel">
        <ToolHistoryEntries entries={entries.filter(entry => entry.kind === wanted)} machineId={machineId} sessionId={sessionId}
            failed={failed} onRetry={retry} showKind={false}
            empty={<p className="tool-history-empty">{t(kind === 'previews' ? 'toolHistory.emptyPreviews' : 'toolHistory.emptyClipboard')}</p>} />
        {kind === 'clipboard' && <button type="button" className="tool-history-device" onClick={() => openClipboardHistory()}>
            <ClipboardList size={14} aria-hidden="true" />
            <span>{t('toolHistory.deviceClipboard')}</span>
        </button>}
    </div>;
}
