/**
 * Which shell the workspace renders (B-795, iPhone Duo / foldables).
 *
 * - expanded / collapsed: the two-pane desktop shell (fine pointer, or a wide
 *   touch screen ≥1100px such as an iPad in landscape).
 * - drawer: a touch screen that clears the two-pane query but is narrower than
 *   1100px — an unfolded foldable (iPhone Duo 890×626, Galaxy Fold ≈ 884) or an
 *   iPad in portrait. A pinned 260px sidebar left ~630px for the conversation
 *   on a 626px-tall screen, so the content keeps the width and the sidebar is a
 *   rail + overlay drawer (UISplitViewController's portrait overlay, Material's
 *   medium-width rail). It closes on navigation, scrim tap and Escape.
 * - list / single: phones (the list at the root, otherwise one screen).
 */
export type AppShellMode = 'expanded' | 'collapsed' | 'drawer' | 'single' | 'list';

/** Touch screens below this width get the drawer instead of a pinned sidebar (matches the 1100px inline-panel breakpoint). */
export const TOUCH_DRAWER_MQ = '(pointer: coarse) and (max-width: 1099px)';

export function appShellMode(input: {
  settings: boolean;
  desktop: boolean;
  touchDrawer: boolean;
  collapsed: boolean;
  atRoot: boolean;
  firstRun: boolean;
  workspaceGuide: boolean;
}): AppShellMode {
  if (input.settings) return 'single';
  if (input.desktop) return input.touchDrawer ? 'drawer' : input.collapsed ? 'collapsed' : 'expanded';
  return input.atRoot && !input.firstRun && !input.workspaceGuide ? 'list' : 'single';
}

/** Modes whose layout includes the sidebar (open or not, in the drawer case). */
export function sidebarMounted(mode: AppShellMode): boolean {
  return mode === 'expanded' || mode === 'list' || mode === 'drawer';
}

/**
 * Folding a two-pane screen into one pane must not unmount the sidebar: its
 * dialogs (新建会话, rename, share, move-to-project …) and its scroll / group
 * state live there. So when the layout alone drops the sidebar (same route) it
 * stays mounted but hidden ("parked") until the route changes — the phone
 * keeps its old cost (no sidebar behind a session) after the next navigation,
 * and unfolding again shows the very same instance.
 */
export function nextSidebarParked(
  parked: boolean,
  prev: { mode: AppShellMode; pathname: string },
  next: { mode: AppShellMode; pathname: string },
): boolean {
  if (next.pathname !== prev.pathname) return false;
  if (sidebarMounted(next.mode)) return false;
  if (next.mode === 'single' && sidebarMounted(prev.mode)) return true;
  return parked;
}
