import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./SessionLiveStatusBar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

describe('fixed live status wiring', () => {
  it('keeps the status slot outside scrollback without dropping permission requests', () => {
    const rows = chat.indexOf('{rows.map((row) =>');
    const permission = chat.indexOf('<PermissionCard sessionId={sessionId} />', rows);
    const statusIndex = chat.indexOf('{showLiveStatus && <div className="cl-live-slot">', rows);
    expect(statusIndex).toBeGreaterThan(permission);
    expect(chat.slice(permission, statusIndex)).toContain('</div>');
    expect(chat.slice(rows, permission)).not.toContain('<SessionLiveStatusBar');
    expect(chat).not.toContain('!hasLiveActivity');
  });
  it('keeps status accessible and details separate from the fixed row', () => {
    expect(status).toContain('<summary className="lsb-content">');
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
    expect(css).toMatch(/\.lsb-details \{[^}]*position:absolute/);
    expect(css).toMatch(/@media \(pointer: coarse\)[^}]*min-height:44px/);
  });
});
