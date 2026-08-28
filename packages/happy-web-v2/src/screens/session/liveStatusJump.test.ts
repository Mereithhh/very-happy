import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./SessionLiveStatusBar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

describe('inline live status wiring', () => {
  it('places fallback live activity inside the transcript after turn rows', () => {
    const statusIndex = chat.indexOf('{showLiveStatus && !hasLiveActivity && <SessionLiveStatusBar');
    expect(statusIndex).toBeGreaterThan(chat.indexOf('{rows.map((row) =>'));
    expect(statusIndex).toBeLessThan(chat.indexOf('<PermissionCard sessionId={sessionId} />', statusIndex));
    expect(statusIndex).toBeGreaterThan(chat.indexOf('className="cl-inner"'));
  });

  it('renders fallback live activity as status content, not a fixed jump action', () => {
    expect(status).not.toContain('<button');
    expect(status).not.toContain('onActivate');
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
    expect(css).toContain('cursor: default');
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 40px/);
    expect(css).not.toContain('var(--accent-dim)');
  });
});
