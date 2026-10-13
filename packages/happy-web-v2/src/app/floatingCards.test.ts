import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// B-588: the PWA install card and the notification opt-in card share ONE
// placement rule — on pages with an input area they move to the top so they
// never cover the composer / send button (they used to sit bottom-wide on phones).
const css = readFileSync(new URL('./floatingCards.css', import.meta.url), 'utf8');

it('moves both onboarding cards to the top on pages with a composer or terminal', () => {
  const rule = css.match(/body:has\(\.sd-foot, \.term-screen\) :is\(\.pwa-install, \.notif-optin\)\s*\{([^}]+)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).toContain('top: calc(env(safe-area-inset-top, 0px) + 56px);');
  expect(rule).toContain('bottom: auto;');
});

it('lets the CLI update banner keep the top edge', () => {
  expect(css).toMatch(/body:has\(\.cli-update\) \.notif-optin \{ display: none; \}/);
});

it('both cards load the shared rule', () => {
  for (const file of ['./PwaInstallPrompt.tsx', '../screens/notifications/NotificationOptInCard.tsx']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toMatch(/import '(\.\/|@\/app\/)floatingCards\.css';/);
  }
});

it('keeps the card short on phones with a composer (decorative preview dropped, below the taller header)', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 520px), (pointer: coarse)'));
  expect(phone).toContain('top: calc(env(safe-area-inset-top, 0px) + 68px);');
  expect(phone).toMatch(/body:has\(\.sd-foot, \.term-screen\) \.notif-optin-preview \{ display: none; \}/);
});
