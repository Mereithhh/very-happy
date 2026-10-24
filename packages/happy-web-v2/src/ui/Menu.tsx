/**
 * Menu — ONE definition, two surfaces.
 *
 * Action menus across the app (sidebar row "more", board card, task lane)
 * are described as `MenuItemDef[]` data and rendered through exactly two
 * wrappers sharing the `vh-menu` panel styling:
 *
 *  - ActionDropdownMenu: the classic "…" button dropdown (all pointers —
 *    the only way in on touch).
 *  - ActionContextMenu: right-click (or touch long-press, Radix default)
 *    anywhere on the wrapped element opens the SAME items at the pointer.
 *
 * B-798 (U2): both are capped to the room on screen and scroll (ui/menu.css),
 * and on a narrow touch screen both open as the SAME bottom sheet
 * (`menuIsSheet`), so ⋯ and long-press look and behave alike on a phone.
 *
 * Keeping items as data means icon, label, danger tone and disabled state
 * are maintained in one place per menu — the two surfaces can't drift.
 *
 * Deliberately NOT used by picker-style menus (ModeMenu, PresetsMenu): those
 * are selection lists with a check column, not action lists.
 */
import { Fragment, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMediaQuery } from '@/app/useMediaQuery';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { LucideIcon } from 'lucide-react';
import { isTerminalInputElement } from '@/screens/terminal/termInputElement';
import './menu.css';

/**
 * Focus give-back for the web terminal.
 *
 * Opening one of these menus while typing in the terminal steals focus: the
 * trigger pointerdown lands on a non-focusable row/card, focus falls to
 * <body>, and on close Radix restores it to the trigger button (dropdown) or
 * leaves it on body (context menu — verified with real pointer input against
 * radix 2.2.16). Typing — including IME input — then goes NOWHERE until the
 * user clicks the terminal canvas again. Remember the last real focus owner
 * and, if it was the terminal's input element, give focus back when the menu
 * closes. Deliberately restricted to THAT element (either path — xterm's
 * helper textarea or our own overlay, see termInputElement): restoring to
 * arbitrary inputs would fight modals that open from menu items (Rename).
 */
let lastFocusOwner: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target as Element | null;
      // menu items/content briefly take focus while open — not an "owner"
      if (t && t !== document.body && !t.closest('.vh-menu')) lastFocusOwner = t;
    },
    true,
  );
}
function giveFocusBackToTerminal(e: Event) {
  const el = lastFocusOwner as HTMLElement | null;
  // Input-element coupling point 8/11 (spec 现状表).
  if (el && el.isConnected && isTerminalInputElement(el)) {
    e.preventDefault(); // suppress Radix's trigger/body restore
    el.focus();
  }
}

export interface MenuChoiceDef {
  key: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}

export interface MenuItemDef {
  key: string;
  label: string;
  /** every action item carries an icon — 16px, dim; danger items inherit red */
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  /** draw a separator above this item (section boundary) */
  separatorBefore?: boolean;
  /**
   * Present ⇒ this item is a TOGGLE, rendered as a menuitemcheckbox so its
   * on/off state reaches assistive tech. Needed since B-293 collapsed the
   * mobile header toggles (select mode, files, /btw) into these menus: as
   * plain items they carried no state at all on exactly the viewport where
   * the menu is their only route, having lost the aria-pressed they had as
   * header buttons.
   */
  checked?: boolean;
  /**
   * B-798 (U2 step 3): present ⇒ ONE row of mutually exclusive choices (the
   * session's 优先级 P0 / P1 / P2): `label` + `icon` head the row and each
   * choice is its own menuitemcheckbox. `onSelect` of the row is then unused.
   */
  choices?: MenuChoiceDef[];
  onSelect: () => void;
}

function itemClass(item: MenuItemDef): string {
  return `vh-menu-item${item.danger ? ' is-danger' : ''}`;
}

function ItemIcon({ item }: { item: MenuItemDef }) {
  const Icon = item.icon;
  return <Icon size={16} className="vh-menu-ico" aria-hidden />;
}

/** B-798 (U2): where a ⋯ menu turns into the bottom sheet — a touch screen no wider than a phone (Duo cover 466). */
export const MENU_SHEET_MQ = '(pointer: coarse) and (max-width: 600px)';

/**
 * B-798 (U2): which action menus open as the bottom sheet. On a narrow touch
 * screen every one does — ⋯ and long-press alike, titled or not. A titled
 * long-press menu (B-762: sidebar tree rows) stays a sheet on any touch screen.
 */
export function menuIsSheet(surface: 'dropdown' | 'context', opts: { titled: boolean; coarse: boolean; narrowCoarse: boolean }): boolean {
  if (opts.narrowCoarse) return true;
  return surface === 'context' && opts.titled && opts.coarse;
}

export function menuClassName(sheet: boolean, contentClassName?: string): string {
  return ['vh-menu', sheet ? 'vh-menu--sheet' : '', contentClassName ?? ''].filter(Boolean).join(' ');
}

/** Breathing room Radix keeps between a popover menu and the screen edge (the scroll cap is measured inside it). */
const COLLISION_PADDING = 8;

/** The Radix parts both surfaces render items with — one item renderer for two menus. */
type MenuParts = {
  Item: typeof DropdownMenu.Item;
  CheckboxItem: typeof DropdownMenu.CheckboxItem;
  Separator: typeof DropdownMenu.Separator;
  Group: typeof DropdownMenu.Group;
  Label: typeof DropdownMenu.Label;
};
const DROPDOWN_PARTS: MenuParts = DropdownMenu;
const CONTEXT_PARTS = ContextMenu as unknown as MenuParts;

function MenuItems({ items, parts: P, title }: { items: MenuItemDef[]; parts: MenuParts; title?: string }) {
  return (
    <>
      {title && <P.Label className="vh-menu-sheet-title">{title}</P.Label>}
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.separatorBefore && <P.Separator className="vh-menu-sep" />}
          {item.choices ? (
            <P.Group className="vh-menu-choices" aria-label={item.label}>
              <span className="vh-menu-choices-label" aria-hidden><ItemIcon item={item} /> {item.label}</span>
              <span className="vh-menu-choices-row">
                {item.choices.map((choice) => (
                  <P.CheckboxItem
                    key={choice.key}
                    className="vh-menu-item vh-menu-choice"
                    disabled={item.disabled}
                    checked={choice.checked}
                    onSelect={choice.onSelect}
                  >
                    {choice.label}
                  </P.CheckboxItem>
                ))}
              </span>
            </P.Group>
          ) : item.checked === undefined ? (
            <P.Item className={itemClass(item)} disabled={item.disabled} onSelect={item.onSelect}>
              <ItemIcon item={item} /> {item.label}
            </P.Item>
          ) : (
            <P.CheckboxItem className={itemClass(item)} disabled={item.disabled} checked={item.checked} onSelect={item.onSelect}>
              <ItemIcon item={item} /> {item.label}
            </P.CheckboxItem>
          )}
        </Fragment>
      ))}
    </>
  );
}

function useMenuSheet(surface: 'dropdown' | 'context', titled: boolean): boolean {
  const narrowCoarse = useMediaQuery(MENU_SHEET_MQ);
  const coarse = useMediaQuery('(pointer: coarse)');
  return menuIsSheet(surface, { titled, coarse, narrowCoarse });
}

/** Wires the release guard to a trigger: its pointerdown handler and the menu's onOpenChange. */
function useReleaseClickGuard() {
  const [guard] = useState(() => createLongPressReleaseGuard());
  const contentRef = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    guard.press();
    const end = () => {
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      if (guard.release()) dropReleaseClick(() => contentRef.current);
    };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
  };
  const onOpenChange = (open: boolean) => (open ? guard.opened() : guard.closed());
  return { contentRef, onPointerDown, onOpenChange };
}

/** "More actions" dropdown — `children` is the trigger button. */
export function ActionDropdownMenu({
  items,
  children,
  align = 'end',
  sideOffset = 4,
  matchTriggerWidth = false,
  contentMinWidth,
  contentClassName,
  sheetTitle,
}: {
  items: MenuItemDef[];
  children: React.ReactElement;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  matchTriggerWidth?: boolean;
  /** px floor for the panel when the trigger is only part of a wider control (B-676 split button) */
  contentMinWidth?: number;
  /** extra class on the menu panel — e.g. to stack above a higher layer (B-559) */
  contentClassName?: string;
  /** B-798: heads the bottom sheet a narrow touch screen opens (pass the same name as the row's long-press menu). */
  sheetTitle?: string;
}) {
  const sheet = useMenuSheet('dropdown', !!sheetTitle);
  const { contentRef, onPointerDown, onOpenChange } = useReleaseClickGuard();
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild onPointerDown={onPointerDown}>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          className={menuClassName(sheet, contentClassName)}
          style={sheet ? undefined : matchTriggerWidth ? { minWidth: 'var(--radix-dropdown-menu-trigger-width, 0px)' } : contentMinWidth ? { minWidth: contentMinWidth } : undefined}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={COLLISION_PADDING}
          onCloseAutoFocus={giveFocusBackToTerminal}
        >
          <MenuItems items={items} parts={DROPDOWN_PARTS} title={sheet ? sheetTitle : undefined} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * B-774 (QA5 O6): a touch long-press opens the menu while the finger is still
 * down; lifting it fires the browser's compat click at that spot, which is now
 * on the menu — the sidebar's bottom sheet put 「重命名」 under the finger, so
 * the long press renamed instead of showing the menu. Only the first click
 * right after that release (`RELEASE_CLICK_MS`) is the release's own: dropped
 * when it lands in the menu, ignored elsewhere; any later tap selects as usual.
 *
 * B-798: the ⋯ dropdown opens on pointerdown for touch too, and its bottom sheet
 * can sit under the finger the same way, so both surfaces use the guard.
 *
 * Pure state: `release()` says whether the press that just ended opened the menu.
 */
export const RELEASE_CLICK_MS = 400;
export function createLongPressReleaseGuard() {
  let pressDown = false;
  let openedByPress = false;
  return {
    /** a non-mouse press began on the trigger */
    press() { pressDown = true; openedByPress = false; },
    opened() { if (pressDown) openedByPress = true; },
    closed() { openedByPress = false; },
    /** that press ended (pointerup / pointercancel anywhere): true ⇒ it opened the menu */
    release(): boolean {
      const long = pressDown && openedByPress;
      pressDown = false;
      openedByPress = false;
      return long;
    },
  };
}

/** Drop the release's own click if it lands in the menu; any click (or the timeout) ends the watch. */
function dropReleaseClick(menu: () => HTMLElement | null): void {
  const stop = () => { clearTimeout(timer); document.removeEventListener('click', onClick, true); };
  const onClick = (e: MouseEvent) => {
    stop();
    const el = menu();
    if (el && e.target instanceof Node && el.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
  };
  const timer = setTimeout(stop, RELEASE_CLICK_MS);
  document.addEventListener('click', onClick, true);
}

/** Right-click menu — wraps `children` as the context target. The menu only
 *  attaches to chrome elements (rows, cards, lane headers); surfaces with
 *  their own contextmenu semantics (the terminal canvas) are never wrapped. */
export function ActionContextMenu({
  items,
  children,
  contentClassName,
  sheetTitle,
}: {
  items: MenuItemDef[];
  children: React.ReactElement;
  contentClassName?: string;
  /** B-762: on touch the long-press menu becomes a bottom sheet headed by this name (sidebar tree rows). */
  sheetTitle?: string;
}) {
  const sheet = useMenuSheet('context', !!sheetTitle);
  const { contentRef, onPointerDown, onOpenChange } = useReleaseClickGuard();
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild onPointerDown={onPointerDown}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content ref={contentRef} className={menuClassName(sheet, contentClassName)} collisionPadding={COLLISION_PADDING} onCloseAutoFocus={giveFocusBackToTerminal}>
          <MenuItems items={items} parts={CONTEXT_PARTS} title={sheet ? sheetTitle : undefined} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
