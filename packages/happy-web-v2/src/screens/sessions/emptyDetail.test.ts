import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('connected-machine workspace guide', () => {
  const screen = readFileSync(new URL('./EmptyDetail.tsx', import.meta.url), 'utf8');
  const english = readFileSync(new URL('../../text/_default.ts', import.meta.url), 'utf8');
  const chinese = readFileSync(new URL('../../text/translations/zh-Hans.ts', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('./emptyDetail.css', import.meta.url), 'utf8');
  const publicDocs = readFileSync(new URL('../public/publicContent.ts', import.meta.url), 'utf8');
  const gettingStarted = readFileSync(new URL('../../../../../docs/getting-started.md', import.meta.url), 'utf8');

  it('starts a real chat, terminal, or settings route from the three-step guide', () => {
    expect(screen).toContain('createChatOrConfigure(navigate');
    expect(screen).toContain('createTerminalOrPick(navigate)');
    expect(screen).toContain("navigate('/settings')");
    expect(screen).toContain('<NewSessionModal');
  });

  it('introduces every requested workspace capability in English and Chinese', () => {
    for (const key of ['shortcuts', 'files', 'notes', 'todos', 'views', 'fileHandoff', 'clipboard']) {
      expect(screen).toContain(`key: '${key}'`);
    }
    for (const phrase of ['copy_to_clipboard', 'Terminal ↔ structured text', 'Paste a file into a terminal', 'Scratch notes']) expect(english).toContain(phrase);
    for (const phrase of ['终端 ↔ 结构化文本', '把文件直接粘贴到终端', '临时笔记本', '直接让 AI 复制给你']) expect(chinese).toContain(phrase);
  });

  it('keeps guide actions touch-sized and collapses to one column on narrow screens', () => {
    expect(styles).toMatch(/\.ed-guide__steps button \{ min-height: 44px; \}/);
    expect(styles).toMatch(/\.ed-guide__docs button \{[^}]*min-height: 44px;/s);
    expect(styles).toMatch(/@media \(max-width: 820px\).*\.ed-guide__steps \{ grid-template-columns: minmax\(0, 1fr\); \}/s);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('keeps the same capability tour in public and repository documentation', () => {
    for (const source of [publicDocs, gettingStarted]) {
      for (const phrase of ['Command/Ctrl', 'Files', 'Todo', 'structured text', 'copy_to_clipboard', 'Settings']) {
        expect(source).toContain(phrase);
      }
      expect(source).toMatch(/clipboard image\/file|clipboard image|clipboard.*file/i);
    }
  });
});
