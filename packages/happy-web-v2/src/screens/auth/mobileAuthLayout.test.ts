import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./auth.css', import.meta.url), 'utf8');
const login = readFileSync(new URL('./LoginScreen.tsx', import.meta.url), 'utf8');
const signup = readFileSync(new URL('./SignupScreen.tsx', import.meta.url), 'utf8');
const viewportPin = readFileSync(new URL('../../app/useKeyboardViewportPin.ts', import.meta.url), 'utf8');

describe('mobile auth layout', () => {
  it('keeps the full card scrollable inside the dynamic iOS viewport', () => {
    expect(styles).toMatch(/\.auth-page \{[\s\S]*height: 100dvh;/);
    expect(styles).toMatch(/\.auth-page \{[\s\S]*min-height: 100dvh;/);
    expect(styles).toMatch(/\.auth-page \{[\s\S]*overflow-y: auto;/);
    expect(styles).toContain('-webkit-overflow-scrolling: touch;');
  });

  it('respects every iOS standalone safe area on compact screens', () => {
    const compact = styles.slice(styles.indexOf('@media (max-width: 720px), (max-height: 700px)'));
    expect(compact).toContain('env(safe-area-inset-top)');
    expect(compact).toContain('env(safe-area-inset-right)');
    expect(compact).toContain('env(safe-area-inset-bottom)');
    expect(compact).toContain('env(safe-area-inset-left)');
    expect(compact).toContain('.auth-card { margin: 0;');
  });

  it('top-aligns short viewports and the iOS keyboard state', () => {
    expect(styles).toContain('@media (max-width: 720px), (max-height: 700px)');
    expect(styles).toContain(".auth-page[data-keyboard-open='true'] { align-items: flex-start; }");
    expect(viewportPin).toContain("el.dataset.keyboardOpen = 'true'");
    expect(viewportPin).toContain('delete el.dataset.keyboardOpen');
    for (const screen of [login, signup]) {
      expect(screen).toContain('useKeyboardViewportPin(pageRef)');
      expect(screen).toContain('className="auth-page" ref={pageRef}');
    }
  });

  it('keeps primary auth actions at the iOS touch-target floor', () => {
    expect(styles).toMatch(/\.auth-email > \.vh-btn,[\s\S]*\.auth-alt \{ min-height: 44px; \}/);
    expect(styles).toMatch(/\.auth-card--login \.auth-method-toggle \{[\s\S]*min-height: 44px;/);
  });

  it('prioritizes the auth form by removing the decorative brand section on phones', () => {
    expect(styles).toMatch(/@media \(max-width: 720px\) \{[\s\S]*\.auth-brand-panel \{ display: none; \}/);
    expect(styles).toMatch(/@media \(max-width: 720px\) \{[\s\S]*\.auth-form-panel \{[\s\S]*gap: var\(--sp-3\);[\s\S]*padding: var\(--sp-4\);/);
    expect(styles).toMatch(/@media \(max-width: 720px\) \{[\s\S]*\.auth-language-switcher \{[\s\S]*position: absolute;/);
    expect(login).toContain('<section className="auth-brand-panel"');
  });
});
