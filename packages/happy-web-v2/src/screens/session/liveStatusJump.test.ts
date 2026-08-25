import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const detail = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const status = readFileSync(new URL('./SessionLiveStatusBar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./statusbar.css', import.meta.url), 'utf8');

describe('live status jump wiring', () => {
  it('routes status activation through the transcript jump request', () => {
    expect(detail).toContain('jumpRequest={jumpToLatestRequest}');
    expect(detail).toContain('setJumpToLatestRequest((request) => request + 1)');
    expect(chat).toContain('if (jumpRequest > 0) scrollToBottom(true)');
  });

  it('renders every live status as a keyboard and touch-friendly action', () => {
    expect(status.match(/<button/g)).toHaveLength(2);
    expect(status.match(/onClick=\{onActivate\}/g)).toHaveLength(2);
    expect(status.match(/aria-label=/g)).toHaveLength(2);
    expect(status).toContain('const accessibleLabel');
    expect(status).toContain("title={t('session.chat.jumpToLatest')}");
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/);
    expect(css).toContain('.lsb:focus-visible');
  });
});
