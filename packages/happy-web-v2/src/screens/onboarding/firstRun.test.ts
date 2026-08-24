import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldShowFirstRun } from './firstRun';

describe('shouldShowFirstRun', () => {
  it('waits for hydration before deciding the account is new', () => {
    expect(shouldShowFirstRun(false, 0)).toBe(false);
  });

  it('shows only when the hydrated account has no registered machine', () => {
    expect(shouldShowFirstRun(true, 0)).toBe(true);
    expect(shouldShowFirstRun(true, 1)).toBe(false);
  });
});

describe('first-machine command sequence', () => {
  const screen = readFileSync(new URL('./FirstRunScreen.tsx', import.meta.url), 'utf8');
  const english = readFileSync(new URL('../../text/_default.ts', import.meta.url), 'utf8');
  const chinese = readFileSync(new URL('../../text/translations/zh-Hans.ts', import.meta.url), 'utf8');

  it('makes daemon startup the final copyable step before the workspace takes over', () => {
    expect(screen).toContain("const DAEMON_START_COMMAND = 'very-happy daemon start'");
    expect(screen).toContain('<Command value={DAEMON_START_COMMAND} />');
    expect(screen.indexOf("t('onboarding.linkTitle')")).toBeLessThan(screen.indexOf("t('onboarding.daemonTitle')"));
    expect(screen).not.toContain("t('onboarding.startTitle')");
    expect(english).toContain('this page moves to the workspace; choose New session there');
    expect(chinese).toContain('本页会进入工作区；接着点击“新建会话”');
  });

  it('does not tell users to choose a removed authentication channel', () => {
    expect(english).toContain('The CLI also tries to open it for you');
    expect(chinese).toContain('CLI 也会尝试自动打开');
    expect(english).not.toContain('choose Web Browser');
    expect(chinese).not.toContain('选择「Web Browser」');
  });

  it('keeps command copy targets large enough for touch', () => {
    const styles = readFileSync(new URL('./firstRun.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.fr-command button \{[^}]*width: 44px;[^}]*height: 44px;/s);
  });
});
