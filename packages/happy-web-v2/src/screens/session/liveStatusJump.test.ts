import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./SessionLiveStatusBar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

describe('live status jump wiring', () => {
  it('keeps live activity inside the main transcript area and jumps locally', () => {
    expect(chat).toContain('<SessionLiveStatusBar sessionId={sessionId} onActivate={() => scrollToBottom(true)} />');
    expect(chat.lastIndexOf('<SessionLiveStatusBar')).toBeGreaterThan(chat.indexOf('className="cl-scroll"'));
  });

  it('renders live activity as a keyboard and touch-friendly action', () => {
    expect(status.match(/<button/g)).toHaveLength(1);
    expect(status.match(/onClick=\{onActivate\}/g)).toHaveLength(1);
    expect(status.match(/aria-label=/g)).toHaveLength(1);
    expect(status).toContain('const accessibleLabel');
    expect(status).toContain("title={t('session.chat.jumpToLatest')}");
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 40px/);
    expect(css).toContain('.lsb:focus-visible');
    expect(css).not.toContain('var(--accent-dim)');
  });
});
