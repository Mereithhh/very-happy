import { Outlet, useLocation } from 'react-router-dom';
import { useIsDesktop } from '@/app/useMediaQuery';
import { Sidebar } from '@/screens/sessions/Sidebar';
import './layout.css';

export function AppLayout() {
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const atRoot = location.pathname === '/' || location.pathname === '';

  if (isDesktop) {
    return (
      <div className="app-shell">
        <aside className="app-sidebar">
          <Sidebar />
        </aside>
        <main className="app-detail">
          <Outlet />
        </main>
      </div>
    );
  }

  // mobile: single pane — sidebar at root, detail otherwise (detail provides its own back nav)
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
