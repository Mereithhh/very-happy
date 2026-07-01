import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { useIsDesktop } from '@/app/useMediaQuery';
import { useSidebarPrefs, SIDEBAR_MIN, SIDEBAR_MAX } from '@/app/useSidebarPrefs';
import { Sidebar } from '@/screens/sessions/Sidebar';
import './layout.css';

export function AppLayout() {
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const atRoot = location.pathname === '/' || location.pathname === '';
  const { width, collapsed, setWidth, setCollapsed } = useSidebarPrefs();
  const draggingRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.classList.add('vh-col-resizing');
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      setWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('vh-col-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setWidth]);

  if (isDesktop) {
    if (collapsed) {
      return (
        <div className="app-shell app-shell--collapsed" style={{ gridTemplateColumns: '46px 1fr' }}>
          <div className="app-rail">
            <button
              className="app-rail-btn"
              onClick={() => setCollapsed(false)}
              aria-label="expand sidebar"
              title="Show sidebar"
            >
              <PanelLeft size={18} />
            </button>
          </div>
          <main className="app-detail">
            <Outlet />
          </main>
        </div>
      );
    }
    return (
      <div className="app-shell" style={{ gridTemplateColumns: `${width}px 6px 1fr` }}>
        <aside className="app-sidebar">
          <Sidebar />
        </aside>
        <div
          className="app-resize-handle"
          onMouseDown={onDragStart}
          role="separator"
          aria-orientation="vertical"
        />
        <main className="app-detail">
          <Outlet />
        </main>
      </div>
    );
  }

  // mobile: single pane — sidebar at root, detail otherwise (detail has its own back nav)
  return (
    <div className="app-shell app-shell--mobile">
      {atRoot ? (
        <aside className="app-sidebar app-sidebar--full">
          <Sidebar />
        </aside>
      ) : (
        <main className="app-detail app-detail--full">
          <Outlet />
        </main>
      )}
    </div>
  );
}
