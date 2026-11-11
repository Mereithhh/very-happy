import { create } from 'zustand';

const WIDTH_KEY = 'vh.sidebar.width';
const COLLAPSED_KEY = 'vh.sidebar.collapsed';
/** B-926: which entry rows the desktop sidebar keeps (JSON key list; absent = the default four). Per device, not synced. */
const NAV_PINNED_KEY = 'vh.sidebar.navPinned';
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
/** B-926: a stored list of entry keys, or null (default) for anything else. */
export function parseNavPinned(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((k) => typeof k === 'string') ? v : null;
  } catch {
    return null;
  }
}
function loadNavPinned(): string[] | null {
  try {
    return parseNavPinned(localStorage.getItem(NAV_PINNED_KEY));
  } catch {
    return null;
  }
}

interface SidebarPrefs {
  width: number;
  collapsed: boolean;
  /** B-795: the shell is in drawer mode (medium touch screen); set by AppLayout. */
  drawer: boolean;
  /** Drawer open — per visit, never persisted: an unfolded phone starts content-first. */
  drawerOpen: boolean;
  /** B-926: the user's pinned entry keys; null = the default rows (`splitNavEntries`). */
  navPinned: string[] | null;
  setWidth: (w: number) => void;
  /** The sidebar's own collapse button: closes the drawer in drawer mode. */
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  setDrawer: (v: boolean) => void;
  setDrawerOpen: (v: boolean) => void;
  /** null resets to the default rows. */
  setNavPinned: (keys: string[] | null) => void;
}

export const useSidebarPrefs = create<SidebarPrefs>((set, get) => ({
  width: loadWidth(),
  collapsed: loadCollapsed(),
  drawer: false,
  drawerOpen: false,
  navPinned: loadNavPinned(),
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
  setNavPinned: (keys) => {
    try {
      if (keys === null) localStorage.removeItem(NAV_PINNED_KEY);
      else localStorage.setItem(NAV_PINNED_KEY, JSON.stringify(keys));
    } catch { /* storage blocked: the choice lasts for this visit */ }
    set({ navPinned: keys });
  },
}));
