import { useEffect, useState } from 'react';
import { ToolHistory } from './ToolHistory';
import { transcriptClipboardHistory } from '@/sync/toolHistory';
import { useSession, useSessionMessages } from '@/sync/storage';
import { sessionPreviewPaths, legacyPreviewHistory } from './previewTools';

/** Reconstructed from persisted tool calls; closing a preview never removes its entry. */
export function SessionPreviews({ sessionId }: {sessionId:string}) {
    return <PreviewHistory key={sessionId} sessionId={sessionId} />;
}

function PreviewHistory({sessionId}:{sessionId:string}) {
    const {messages} = useSessionMessages(sessionId);
    const session = useSession(sessionId);
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
    return <ToolHistory scope={{sessionId}} machineId={session?.metadata?.machineId} transcript={[
        ...transcriptClipboardHistory(messages),
        ...legacyPreviewHistory(paths, session?.metadata?.path),
    ]} />;
}
