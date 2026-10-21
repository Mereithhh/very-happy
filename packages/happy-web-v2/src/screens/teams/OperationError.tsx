import { teamOperationErrorKind } from './teamView';
import { useWorkspaceCopy } from './workspaceCopy';

/** B-723 (O2): a team operation's failure in the user's language; the daemon's
 *  raw text (English prose or an internal code) stays under a folded 「详情」. */
export function useOperationErrorSummary(): (error: string | null | undefined) => string | null {
  const c = useWorkspaceCopy();
  return (error) => {
    const kind = teamOperationErrorKind(error);
    return kind ? c.opError[kind] ?? c.opError.other : null;
  };
}

export function OperationError({ error, className }: { error: string | null | undefined; className?: string }) {
  const c = useWorkspaceCopy();
  const summary = useOperationErrorSummary()(error);
  if (!summary || !error) return null;
  return <div className={['teams-op-error', className].filter(Boolean).join(' ')}>
    <p>{summary}</p>
    <details className="teams-op-error-details"><summary>{c.opDetails}</summary><code>{error}</code></details>
  </div>;
}
