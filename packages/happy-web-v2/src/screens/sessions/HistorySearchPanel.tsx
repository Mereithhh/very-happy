/**
 * HistorySearchPanel (B-549) — the "Full-text search" mode of the import
 * dialog. Searches what was said in the Claude Code / Codex conversations on
 * one machine through the daemon's `history-search` RPC (the index lives on
 * that machine; only the matching snippets come back), and lets each hit be
 * opened (very-happy already owns it) or imported (the dialog's own import
 * flow: directory confirmation, title, jump to the new chat).
 *
 * The daemon always answers at once. While it is still indexing it says so
 * with progress, and this panel re-asks every couple of seconds so results
 * fill in as the index grows.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Button, Spinner, useToast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { machineHistorySearch } from '@/sync/ops';
import type { Session } from '@/sync/storageTypes';
import { formatSessionAge } from './newTerminalAttach';
import { historySourceLabel, shortenCwd, type HistoryAgent, type HistoryEntry, type ImportRowState } from './claudeHistoryImport';
import {
  findTrackedSessionId,
  HISTORY_SEARCH_DEBOUNCE_MS,
  HISTORY_SEARCH_POLL_MS,
  shouldPollHistorySearch,
  splitHighlights,
  type HistorySearchHit,
  type HistorySearchStatus,
} from './historySearch';

const RESULT_LIMIT = 30;

export function HistorySearchPanel({ machineId, agent, homeDir, sessions, rowStates, busy, importBlocked = false, onImport, onOpen }: {
  machineId: string;
  agent: HistoryAgent;
  homeDir?: string;
  /** Raw session records (mirror sessions included) for the "open" mapping. */
  sessions: ReadonlyArray<Pick<Session, 'id' | 'metadata' | 'updatedAt'>>;
  rowStates: ReadonlyMap<string, ImportRowState>;
  busy: boolean;
  /** The agent cannot run on this machine (Codex not installed): hits can
   *  still be read and opened, not imported. */
  importBlocked?: boolean;
  onImport: (entry: HistoryEntry) => void;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HistorySearchHit[]>([]);
  const [status, setStatus] = useState<HistorySearchStatus | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const [clearing, setClearing] = useState(false);
  const seq = useRef(0);
  /** The last (machine, agent, query) actually sent: a repeat is a poll and
   *  goes out at once, anything new waits for the typing to settle. */
  const lastSent = useRef('');

  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) {
      seq.current += 1;
      setHits([]);
      setTruncated(false);
      setFailed(null);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    const key = `${machineId}\n${agent}\n${trimmed}`;
    const delay = key === lastSent.current ? 0 : HISTORY_SEARCH_DEBOUNCE_MS;
    setLoading(true);
    const timer = setTimeout(() => {
      lastSent.current = key;
      void machineHistorySearch(machineId, { query: trimmed, agent, limit: RESULT_LIMIT }).then((res) => {
        if (mine !== seq.current) return;
        setLoading(false);
        if (!res.ok) { setFailed(res.message ?? ''); return; }
        setFailed(null);
        setHits(res.hits);
        setTruncated(res.truncated);
        setStatus(res.status);
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [machineId, agent, trimmed, pollTick]);

  // While the daemon is still indexing, ask again so results fill in.
  useEffect(() => {
    if (!trimmed || !status || !shouldPollHistorySearch(status)) return;
    const timer = setTimeout(() => setPollTick((n) => n + 1), HISTORY_SEARCH_POLL_MS);
    return () => clearTimeout(timer);
  }, [status, trimmed]);

  async function clearIndex() {
    const ok = await Modal.confirm(t('historySearch.clearConfirmTitle'), t('historySearch.clearConfirmMessage'), { confirmText: t('historySearch.clear') });
    if (!ok) return;
    setClearing(true);
    const res = await machineHistorySearch(machineId, { op: 'clear' });
    setClearing(false);
    if (!res.ok) { toast.error(t('historySearch.failed')); return; }
    seq.current += 1;
    setHits([]);
    setStatus(res.status);
    toast.success(t('historySearch.cleared'));
  }

  const now = Date.now();
  const tracked = useMemo(
    () => new Map(hits.map((h) => [h.key, findTrackedSessionId(h.entry.agent, h.entry.id, sessions)])),
    [hits, sessions],
  );

  return (
    <>
      <div className="ns-path-row">
        <Search size={14} className="ns-search-icon" aria-hidden="true" />
        <input
          className="ns-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('historySearch.placeholder')}
          aria-label={t('historySearch.placeholder')}
          disabled={busy}
          autoFocus
        />
      </div>

      {status?.state === 'indexing' && (
        <div className="ns-loading-row" aria-live="polite">
          <Spinner size={14} />
          <span>{t('historySearch.indexing', { done: status.filesDone, total: status.filesTotal })}</span>
        </div>
      )}
      {status?.state === 'error' && status.error && (
        <div className="ns-hint">{t('historySearch.indexError', { message: status.error })}</div>
      )}

      {!trimmed ? (
        <div className="ns-hint">{t('historySearch.hint')}</div>
      ) : failed !== null ? (
        <div className="ns-hint">{t('historySearch.failed')}{failed ? ` · ${failed}` : ''}</div>
      ) : hits.length === 0 ? (
        status?.state === 'indexing' ? null : loading ? (
          <div className="ns-loading-row"><Spinner size={14} /><span>{t('historySearch.searching')}</span></div>
        ) : (
          <div className="ns-hint">{t('historySearch.noResults')}</div>
        )
      ) : (
        <div className="ns-sessions ns-sessions--tall hs-results" role="list" aria-label={t('historySearch.title')} aria-busy={loading}>
          {hits.map((hit) => {
            const entry = hit.entry;
            const sessionId = tracked.get(hit.key);
            const state = rowStates.get(entry.id) ?? { kind: 'idle' as const };
            const source = historySourceLabel(entry);
            const age = formatSessionAge(entry.updatedAt, now);
            const failedMsg = state.kind === 'failed' ? state.message : undefined;
            return (
              <div key={hit.key} role="listitem" className={`ns-session ns-session--stack hs-row${state.kind === 'failed' ? ' is-failed' : ''}`}>
                <div className="hs-row-head">
                  <span className="ns-session-name hs-row-title" title={entry.firstPrompt}>{hit.title}</span>
                  {sessionId ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => { navigate(`/session/${sessionId}`); onOpen(sessionId); }}>
                      {t('historySearch.open')}
                    </Button>
                  ) : state.kind === 'done' ? (
                    <Button size="sm" variant="secondary" onClick={() => { navigate(`/session/${state.sessionId}`); onOpen(state.sessionId); }}>
                      {t('historySearch.open')}
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" loading={state.kind === 'running'} disabled={busy || importBlocked} onClick={() => onImport(entry)}>
                      {t('historySearch.import')}
                    </Button>
                  )}
                </div>
                {hit.snippets.map((snippet, i) => (
                  <div key={i} className="hs-snippet">
                    <span className="hs-snippet-role">{snippet.role === 'user' ? t('historySearch.roleUser') : t('historySearch.roleAssistant')}</span>
                    <span className="hs-snippet-text">
                      {splitHighlights(snippet.text, snippet.ranges).map((seg, k) => (
                        seg.hit ? <mark key={k} className="hs-mark">{seg.text}</mark> : <span key={k}>{seg.text}</span>
                      ))}
                    </span>
                  </div>
                ))}
                <span className="ns-session-meta mono" title={entry.cwd}>
                  {shortenCwd(entry.cwd, homeDir)}
                  {source ? ` · ${source}` : ''}
                  {age ? ` · ${age}` : ''}
                  {hit.matchCount > 0 ? ` · ${t('historySearch.matches', { count: hit.matchCount })}` : ''}
                  {failedMsg ? ` · ${failedMsg}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {truncated && <div className="ns-hint">{t('historySearch.truncated')}</div>}
      {status && status.evicted > 0 && <div className="ns-hint">{t('historySearch.evicted', { count: status.evicted })}</div>}
      <div className="hs-footer">
        <span className="ns-hint hs-footer-note">{t('historySearch.intro')}</span>
        <Button size="sm" variant="ghost" loading={clearing} disabled={busy || clearing} onClick={() => void clearIndex()}>
          {t('historySearch.clear')}
        </Button>
      </div>
    </>
  );
}
