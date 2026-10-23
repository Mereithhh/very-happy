import { Fragment, type MouseEventHandler, type ReactNode } from 'react';
import type { AppShellMode } from '@/app/appShellMode';

export type { AppShellMode };

/** Keep the routed view and notes at stable React positions across layout changes. */
export function AppShell({ mode, width, sidebar, rail, notes, children, onResizeStart, parked = false, drawerOpen = false, onDrawerClose }: {
  mode: AppShellMode;
  width: number;
  sidebar: ReactNode;
  rail: ReactNode;
  notes: ReactNode;
  children: ReactNode;
  onResizeStart: MouseEventHandler<HTMLDivElement>;
  /** B-795: keep the sidebar mounted but hidden (a fold dropped it; see nextSidebarParked). */
  parked?: boolean;
  drawerOpen?: boolean;
  onDrawerClose?: () => void;
}) {
  const expanded = mode === 'expanded';
  const list = mode === 'list';
  const drawer = mode === 'drawer';
  const railed = mode === 'collapsed' || drawer;
  const columns = expanded ? `${width}px 6px minmax(0, 1fr)` : railed ? 'var(--app-rail-w) minmax(0, 1fr)' : 'minmax(0, 1fr)';
  const showSidebar = expanded || list || drawer || parked;
  const sidebarClass = list ? ' app-sidebar--full'
    : drawer ? ` app-sidebar--drawer${drawerOpen ? ' is-open' : ''}`
    : !expanded ? ' app-sidebar--parked' : '';
  return (
    <div className={`app-shell${railed ? ' app-shell--collapsed' : !expanded ? ' app-shell--mobile' : ''}`} style={{ gridTemplateColumns: columns }}>
      {showSidebar && (
        // Hidden states use size + visibility, never display:none / transform / inert: the
        // sidebar's dialogs render inline (position: fixed) and must stay usable (layout.css).
        <aside key="sidebar" className={`app-sidebar${sidebarClass}`}
          style={drawer ? { width: `calc(min(${width}px, 100vw - var(--app-rail-w) - 24px - var(--sa-l) - var(--sa-r)) + var(--sa-l))` } : undefined}>
          {sidebar}
        </aside>
      )}
      {railed && <div key="rail" className="app-rail">{rail}</div>}
      {expanded && <div key="resize" className="app-resize-handle" onMouseDown={onResizeStart} role="separator" aria-orientation="vertical" />}
      {drawer && drawerOpen && <div key="scrim" className="app-drawer-scrim" onClick={onDrawerClose} aria-hidden />}
      <div key="content" className="app-main-row" style={list ? { display: 'contents' } : undefined}>
        {!list && <main key="detail" className="app-detail">{children}</main>}
        <Fragment key="notes">{notes}</Fragment>
      </div>
    </div>
  );
}
