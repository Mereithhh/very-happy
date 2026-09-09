import { Fragment, type MouseEventHandler, type ReactNode } from 'react';

export type AppShellMode = 'expanded' | 'collapsed' | 'single' | 'list';

/** Keep the routed view and notes at stable React positions across layout changes. */
export function AppShell({ mode, width, sidebar, rail, notes, children, onResizeStart }: {
  mode: AppShellMode;
  width: number;
  sidebar: ReactNode;
  rail: ReactNode;
  notes: ReactNode;
  children: ReactNode;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
}) {
  const expanded = mode === 'expanded';
  const list = mode === 'list';
  const columns = expanded ? `${width}px 6px minmax(0, 1fr)` : mode === 'collapsed' ? '46px minmax(0, 1fr)' : 'minmax(0, 1fr)';
  return (
    <div className={`app-shell${mode === 'collapsed' ? ' app-shell--collapsed' : !expanded ? ' app-shell--mobile' : ''}`} style={{ gridTemplateColumns: columns }}>
      {(expanded || list) && <aside key="sidebar" className={`app-sidebar${list ? ' app-sidebar--full' : ''}`}>{sidebar}</aside>}
      {mode === 'collapsed' && <div key="rail" className="app-rail">{rail}</div>}
      {expanded && <div key="resize" className="app-resize-handle" onMouseDown={onResizeStart} role="separator" aria-orientation="vertical" />}
      <div key="content" className="app-main-row" style={list ? { display: 'contents' } : undefined}>
        {!list && <main key="detail" className="app-detail">{children}</main>}
        <Fragment key="notes">{notes}</Fragment>
      </div>
    </div>
  );
}
