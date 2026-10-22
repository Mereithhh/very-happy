// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { topModalDialog } from './Toast';

/**
 * B-772: a native modal <dialog> (新建团队) is in the top layer and makes the
 * rest of the page inert, so the 「…推送了预览，点击查看」 notice was hidden and
 * unclickable. Measured in Chromium: tmp/vh-b772/o1.mjs (elementFromPoint hits
 * the toast, the click navigates).
 */
describe('toasts stay visible and clickable over a modal dialog', () => {
  it('portals into the topmost modal dialog and re-shows as a manual popover', () => {
    const src = readFileSync(join(process.cwd(), 'src/ui/Toast.tsx'), 'utf8');
    expect(src).toContain('className="vh-toasts" role="region" aria-live="polite" popover="manual"');
    expect(src).toContain('{host ? createPortal(region, host) : region}');
    expect(src).toContain("if (items.length > 0) region.showPopover();");
    const css = readFileSync(join(process.cwd(), 'src/ui/ui.css'), 'utf8');
    expect(css).toMatch(/\.vh-toasts \{[^}]*inset: auto;[^}]*background: transparent;/);
  });

  it('topModalDialog: none open → null; a selector the engine rejects → null', () => {
    document.body.innerHTML = '<dialog></dialog>';
    expect(topModalDialog(document)).toBeNull();
    const broken = { querySelectorAll: () => { throw new SyntaxError(':modal'); } } as unknown as Document;
    expect(topModalDialog(broken)).toBeNull();
  });
});
