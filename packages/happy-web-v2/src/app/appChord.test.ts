import { describe, it, expect } from 'vitest';
import { isAppChord } from './appChord';

/**
 * 回归锚：2026-08-14 的按键 golden 差分实测发现 `Ctrl+K` / `Ctrl+J` 在 macOS 上
 * 被 window-capture 的 app 快捷键截走（命令面板夺焦点 / 静默吞），而它们是终端
 * readline 的 kill-line / accept-line。判据必须按平台分叉。
 */
describe('isAppChord', () => {
  const meta = { metaKey: true, ctrlKey: false };
  const ctrl = { metaKey: false, ctrlKey: true };
  const none = { metaKey: false, ctrlKey: false };

  it('macOS: 只有 ⌘ 是 app 和弦，Ctrl 留给终端', () => {
    expect(isAppChord(meta, true)).toBe(true);
    expect(isAppChord(ctrl, true)).toBe(false); // ← 这一条就是 Ctrl+K/J/N/R 的修复
    expect(isAppChord(none, true)).toBe(false);
  });

  it('非 macOS: Ctrl 是 app 和弦（那里没有 ⌘）', () => {
    expect(isAppChord(ctrl, false)).toBe(true);
    expect(isAppChord(meta, false)).toBe(false);
    expect(isAppChord(none, false)).toBe(false);
  });

  it('两个修饰键同时按下时按平台取各自的那个', () => {
    const both = { metaKey: true, ctrlKey: true };
    expect(isAppChord(both, true)).toBe(true);
    expect(isAppChord(both, false)).toBe(true);
  });
});
