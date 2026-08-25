import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('compact workspace help screen', () => {
  const screen = readFileSync(new URL('./HelpScreen.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('./helpScreen.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../app/AppRoot.tsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../sessions/Sidebar.tsx', import.meta.url), 'utf8');
  const sidebarStyles = readFileSync(new URL('../sessions/sidebar.css', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../settings/SettingsRoutes.tsx', import.meta.url), 'utf8');
  const english = readFileSync(new URL('../../text/_default.ts', import.meta.url), 'utf8');
  const chinese = readFileSync(new URL('../../text/translations/zh-Hans.ts', import.meta.url), 'utf8');

  it('opens automatically for an empty workspace and remains reachable from navigation', () => {
    expect(app).toContain("terminalCount === 0) return <HelpScreen />");
    expect(app).toContain("path: 'help', element: <HelpScreen />");
    expect(sidebar).toContain("navigate('/help')");
    expect(settings).toContain("onClick={() => navigate('/help')}");
  });

  it('keeps the first actions visible and the detailed tour in a single-open accordion', () => {
    expect(screen).toContain('createChatOrConfigure(navigate');
    expect(screen).toContain('createTerminalOrPick(navigate)');
    expect(screen).toContain("navigate('/settings')");
    expect(screen).toContain('<BackButton className="help-screen__back" />');
    expect(screen).toContain('openGroup === key');
    expect(screen).toContain('aria-expanded={open}');
    expect(screen).toContain('setOpenGroup(open ? null : key)');
    expect(screen).toContain('<NewSessionModal');
  });

  it('covers every requested capability in English and Chinese', () => {
    for (const key of ['shortcuts', 'files', 'notes', 'todos', 'views', 'fileHandoff', 'clipboard']) expect(screen).toContain(`key: '${key}'`);
    for (const phrase of ['copy_to_clipboard', 'Terminal ↔ structured text', 'Paste a file into a terminal', 'Scratch notes']) expect(english).toContain(phrase);
    for (const phrase of ['终端 ↔ 结构化文本', '把文件直接粘贴到终端', '临时笔记本', '直接让 AI 复制给你']) expect(chinese).toContain(phrase);
  });

  it('keeps touch targets large, mobile layout compact, and colors tokenized', () => {
    expect(styles).toMatch(/\.help-screen__actions > button \{ min-height: 44px; \}/);
    expect(styles).toMatch(/\.help-topic__trigger \{[^}]*min-height: 70px;/s);
    expect(styles).toMatch(/@media \(max-width: 599px\)/);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('scopes the clickable brand sizing so the public product preview keeps its wordmark', () => {
    expect(sidebar).toContain('sb-brand sb-brand--button');
    expect(sidebarStyles).toMatch(/\.sb-brand--button \{[^}]*width: 38px;/s);
    expect(sidebarStyles).not.toMatch(/\.sb-brand \{[^}]*width:/s);
  });
});
