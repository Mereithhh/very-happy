import { create } from 'zustand';

const WIDTH_KEY = 'vh.sidebar.width';
const COLLAPSED_KEY = 'vh.sidebar.collapsed';
export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 560;
const DEFAULT_WIDTH = 320;

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
  setWidth: (w: number) => void;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
}

export const useSidebarPrefs = create<SidebarPrefs>((set, get) => ({
  width: loadWidth(),
  collapsed: loadCollapsed(),
  setWidth: (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
    localStorage.setItem(WIDTH_KEY, String(clamped));
    set({ width: clamped });
  },
  toggleCollapsed: () => {
    const next = !get().collapsed;
    localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    set({ collapsed: next });
  },
  setCollapsed: (v) => {
    localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    set({ collapsed: v });
  },
}));
