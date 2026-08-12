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
 * Keeping items as data means icon, label, danger tone and disabled state
 * are maintained in one place per menu — the two surfaces can't drift.
 *
 * Deliberately NOT used by picker-style menus (ModeMenu, PresetsMenu): those
 * are selection lists with a check column, not action lists.
 */
import { Fragment } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { LucideIcon } from 'lucide-react';

export interface MenuItemDef {
  key: string;
  label: string;
  /** every action item carries an icon — 16px, dim; danger items inherit red */
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  /** draw a separator above this item (section boundary) */
  separatorBefore?: boolean;
  onSelect: () => void;
}

function itemClass(item: MenuItemDef): string {
  return `vh-menu-item${item.danger ? ' is-danger' : ''}`;
}

function ItemIcon({ item }: { item: MenuItemDef }) {
  const Icon = item.icon;
  return <Icon size={16} className="vh-menu-ico" aria-hidden />;
}

/** "More actions" dropdown — `children` is the trigger button. */
export function ActionDropdownMenu({
  items,
  children,
  align = 'end',
  sideOffset = 4,
}: {
  items: MenuItemDef[];
  children: React.ReactElement;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="vh-menu" align={align} sideOffset={sideOffset}>
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.separatorBefore && <DropdownMenu.Separator className="vh-menu-sep" />}
              <DropdownMenu.Item
                className={itemClass(item)}
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                <ItemIcon item={item} /> {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Right-click menu — wraps `children` as the context target. The menu only
 *  attaches to chrome elements (rows, cards, lane headers); surfaces with
 *  their own contextmenu semantics (the terminal canvas) are never wrapped. */
export function ActionContextMenu({
  items,
  children,
}: {
  items: MenuItemDef[];
  children: React.ReactElement;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="vh-menu">
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.separatorBefore && <ContextMenu.Separator className="vh-menu-sep" />}
              <ContextMenu.Item
                className={itemClass(item)}
                disabled={item.disabled}
                onSelect={item.onSelect}
              >
                <ItemIcon item={item} /> {item.label}
              </ContextMenu.Item>
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
