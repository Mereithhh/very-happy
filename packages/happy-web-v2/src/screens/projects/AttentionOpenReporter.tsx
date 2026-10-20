import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useBoardItems } from '@/screens/board/useBoardItems';
import { useProjects } from '@/sync/projects';
import { reportAttentionOpen } from '@/sync/projectUx';

/**
 * B-651 ②: when the owner opens a session that is waiting for them, report how
 * long it waited (same classifier as the sidebar / board 「等你处理」).
 * Renders nothing. Mounted once in the app layout and keyed off the route, so
 * every way into a session counts (sidebar, board, notification deep link);
 * the board computation only runs while a session route is open.
 */
export function AttentionOpenReporter() {
  const match = /^\/session\/([^/]+)/.exec(useLocation().pathname);
  return match ? <SessionAttentionReporter key={match[1]} sessionId={decodeURIComponent(match[1])} /> : null;
}

function SessionAttentionReporter({ sessionId }: { sessionId: string }) {
  const items = useBoardItems();
  const snap = useProjects();
  const item = items.find((i) => i.key === sessionId);
  const waitingSince = item?.status === 'attention' ? item.attentionSince : undefined;
  const inProject = snap.members.some((m) => m.sessionId === sessionId);
  useEffect(() => {
    if (waitingSince) reportAttentionOpen(sessionId, waitingSince, inProject);
  }, [sessionId, waitingSince, inProject]);
  return null;
}
