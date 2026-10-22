/** B-766: whether this session shows the 汇报板 (see `sessionHasBoard`). */
import { useSession } from '@/sync/storage';
import { useBoardItems } from '@/sync/attentionStore';
import { sessionHasBoard } from './boardModel';

export function useSessionBoard(sessionId: string): boolean {
    const items = useBoardItems(sessionId);
    const capabilities = useSession(sessionId)?.metadata?.capabilities;
    return sessionHasBoard(items, capabilities);
}
