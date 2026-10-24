/**
 * B-798 (P0-1, U2): every action menu fits the screen and scrolls, and on a
 * narrow touch screen ⋯ and long-press open the same bottom sheet.
 * Measured in Chromium on phone / Duo cover / Duo open (scripts/dev/device-shots.mjs --pages menus).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MENU_SHEET_MQ, menuClassName, menuIsSheet } from './Menu';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const menuCss = strip(readFileSync(new URL('./menu.css', import.meta.url), 'utf8'));
const sidebarCss = strip(readFileSync(new URL('../screens/sessions/sidebar.css', import.meta.url), 'utf8'));
const menuSrc = readFileSync(new URL('./Menu.tsx', import.meta.url), 'utf8');

/** Body of the first top-level rule whose selector is exactly `sel`. */
function topRule(src: string, sel: string): string | null {
  const re = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  return re.exec(src)?.[2] ?? null;
}

describe('B-798 P0-1: a long menu is capped to the screen and scrolls', () => {
  it('.vh-menu takes its max-height from the room Radix measured, and scrolls inside', () => {
    const body = topRule(menuCss, '.vh-menu');
    expect(body).not.toBeNull();
    expect(body).toMatch(/max-height:\s*var\(--radix-popper-available-height,\s*80dvh\)/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });
  it('both surfaces keep a margin to the screen edge (the cap is measured inside it)', () => {
    expect(menuSrc).toMatch(/<DropdownMenu\.Content[^>]*collisionPadding=\{COLLISION_PADDING\}/);
    expect(menuSrc).toMatch(/<ContextMenu\.Content[^>]*collisionPadding=\{COLLISION_PADDING\}/);
  });
  it('the menu panel styles live in ui/menu.css, loaded by Menu.tsx — not in the sidebar', () => {
    expect(menuSrc).toContain("import './menu.css';");
    expect(sidebarCss).not.toMatch(/\.vh-menu/);
  });
});

describe('B-798 U2: bottom sheet on narrow touch screens', () => {
  const at = (coarse: boolean, narrowCoarse: boolean) => ({ coarse, narrowCoarse });
  it('a narrow touch screen opens every ⋯ and long-press menu as the sheet, titled or not', () => {
    for (const surface of ['dropdown', 'context'] as const) {
      for (const titled of [true, false]) expect(menuIsSheet(surface, { titled, ...at(true, true) })).toBe(true);
    }
  });
  it('wider touch screens keep the ⋯ popover; titled long-press stays a sheet (B-762)', () => {
    expect(menuIsSheet('dropdown', { titled: true, ...at(true, false) })).toBe(false);
    expect(menuIsSheet('context', { titled: true, ...at(true, false) })).toBe(true);
    expect(menuIsSheet('context', { titled: false, ...at(true, false) })).toBe(false);
  });
  it('a fine pointer never gets the sheet', () => {
    expect(menuIsSheet('dropdown', { titled: true, ...at(false, false) })).toBe(false);
    expect(menuIsSheet('context', { titled: true, ...at(false, false) })).toBe(false);
  });
  it('the narrow arm is a phone-width touch screen (the Duo cover is 466 wide)', () => {
    expect(MENU_SHEET_MQ).toBe('(pointer: coarse) and (max-width: 600px)');
  });
  it('the sheet class is what the CSS sheet rules key on', () => {
    expect(menuClassName(true, 'nc-row-menu')).toBe('vh-menu vh-menu--sheet nc-row-menu');
    expect(menuClassName(false)).toBe('vh-menu');
    expect(menuCss).toMatch(/@media \(pointer: coarse\) \{\s*\[data-radix-popper-content-wrapper\]:has\(> \.vh-menu--sheet\)/);
  });
  it('the sheet cap overrides the popover cap (it comes later in the file)', () => {
    expect(menuCss.indexOf('.vh-menu--sheet {')).toBeGreaterThan(menuCss.indexOf('.vh-menu {'));
    expect(menuCss).toMatch(/\.vh-menu--sheet \{[^}]*max-height:\s*70dvh;[^}]*overflow-y:\s*auto/);
  });
  it('the ⋯ dropdown decides through the same hook and guards its release click like long-press', () => {
    expect(menuSrc).toContain("const sheet = useMenuSheet('dropdown', !!sheetTitle);");
    expect(menuSrc).toContain("const sheet = useMenuSheet('context', !!sheetTitle);");
    // Measured: without it the tap that opens a phone sheet over the finger picks 「重命名」 (device-shots --pages menus).
    expect(menuSrc).toContain('<DropdownMenu.Trigger asChild onPointerDown={onPointerDown}>');
    expect(menuSrc).toContain('<ContextMenu.Trigger asChild onPointerDown={onPointerDown}>');
    expect(menuSrc).toMatch(/<DropdownMenu\.Root onOpenChange=\{onOpenChange\}>/);
    expect(menuSrc).toMatch(/<DropdownMenu\.Content\s+ref=\{contentRef\}/);
  });
});
