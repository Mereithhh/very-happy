export type SessionPanelTab = 'changed' | 'all' | 'browse';

const QUERY_TO_TAB: Record<string, SessionPanelTab> = {
  changes: 'changed',
  files: 'all',
  browse: 'browse',
};

const TAB_TO_QUERY: Record<SessionPanelTab, string> = {
  changed: 'changes',
  all: 'files',
  browse: 'browse',
};

export function readSessionPanel(value: string | null): SessionPanelTab | null {
  return value ? QUERY_TO_TAB[value] ?? null : null;
}

export function withSessionPanel(params: URLSearchParams, tab: SessionPanelTab | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === null) next.delete('panel');
  else next.set('panel', TAB_TO_QUERY[tab]);
  return next;
}
