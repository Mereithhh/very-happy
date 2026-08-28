import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./SessionLiveStatusBar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

describe('inline live status wiring', () => {
  it('keeps live activity inside the transcript after turn rows for the whole running turn', () => {
    const statusIndex = chat.indexOf('{showLiveStatus && <SessionLiveStatusBar');
    expect(statusIndex).toBeGreaterThan(chat.indexOf('{rows.map((row) =>'));
    expect(statusIndex).toBeLessThan(chat.indexOf('<PermissionCard sessionId={sessionId} />', statusIndex));
    expect(statusIndex).toBeGreaterThan(chat.indexOf('className="cl-inner"'));
    expect(chat).not.toContain('!hasLiveActivity');
  });

  it('renders persistent live activity as animated status content, not a fixed jump action', () => {
    expect(status).not.toContain('<button');
    expect(status).not.toContain('onActivate');
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
    expect(status).toContain('<StatusDot status="thinking" size={8} pulse />');
    expect(css).toContain('cursor: default');
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 40px/);
    expect(css).not.toContain('var(--accent-dim)');
  });
});
