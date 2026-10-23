import { create } from 'zustand';

const WIDTH_KEY = 'vh.sidebar.width';
const COLLAPSED_KEY = 'vh.sidebar.collapsed';
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 560;
const DEFAULT_WIDTH = 260;

function loadWidth(): number {
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : DEFAULT_WIDTH;
}
function loadCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_KEY) === '1';
}

interface SidebarPrefs {
  width: number;
  collapsed: boolean;
  /** B-795: the shell is in drawer mode (medium touch screen); set by AppLayout. */
  drawer: boolean;
  /** Drawer open — per visit, never persisted: an unfolded phone starts content-first. */
  drawerOpen: boolean;
  setWidth: (w: number) => void;
  /** The sidebar's own collapse button: closes the drawer in drawer mode. */
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  setDrawer: (v: boolean) => void;
  setDrawerOpen: (v: boolean) => void;
}

export const useSidebarPrefs = create<SidebarPrefs>((set, get) => ({
  width: loadWidth(),
  collapsed: loadCollapsed(),
  drawer: false,
  drawerOpen: false,
  setWidth: (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
    localStorage.setItem(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
  toggleCollapsed: () => {
    if (get().drawer) {
      set({ drawerOpen: !get().drawerOpen });
      return;
    }
    const next = !get().collapsed;
    localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    set({ collapsed: next });
  },
  setCollapsed: (v) => {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    set({ collapsed: v });
  },
  setDrawer: (v) => set(v ? { drawer: true } : { drawer: false, drawerOpen: false }),
  setDrawerOpen: (v) => set({ drawerOpen: v }),
}));
