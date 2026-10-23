import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// B-588: the PWA install card and the notification opt-in card share ONE
// placement rule — on pages with an input area they move to the top so they
// never cover the composer / send button (they used to sit bottom-wide on phones).
const css = readFileSync(new URL('./floatingCards.css', import.meta.url), 'utf8');

it('moves both onboarding cards to the top on pages with a composer or terminal', () => {
  const rule = css.match(/body:has\(\.sd-foot, \.term-screen, \.mri\) :is\(\.pwa-install, \.notif-optin, \.signin-nudge\)\s*\{([^}]+)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).toContain('top: calc(var(--sa-t) + 56px);');
  expect(rule).toContain('bottom: auto;');
});

it('both cards yield to the CLI update banner and to the session banners under the header', () => {
  expect(css).toMatch(/body:has\(\.cli-update, \.mrb\) :is\(\.pwa-install, \.notif-optin, \.signin-nudge\) \{ display: none; \}/);
  // the CLI banner no longer hides itself for the install card (both would vanish)
  const banner = readFileSync(new URL('./cliUpdateBanner.css', import.meta.url), 'utf8');
  expect(banner).not.toMatch(/has\(\.pwa-install\)\s*\.cli-update/);
});

it('both cards load the shared rule', () => {
  for (const file of ['./PwaInstallPrompt.tsx', '../screens/notifications/NotificationOptInCard.tsx', './SignInMethodsNudge.tsx']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toMatch(/import '(\.\/|@\/app\/)floatingCards\.css';/);
  }
});

it('keeps the card short on phones with a composer (decorative preview dropped, below the taller header)', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 520px), (pointer: coarse)'));
  expect(phone).toContain('top: calc(var(--sa-t) + 68px);');
  expect(phone).toMatch(/body:has\(\.sd-foot, \.term-screen, \.mri\) \.notif-optin-preview \{ display: none; \}/);
});

it('B-668: the two invitations wait for the sign-in methods card instead of stacking on it', () => {
  expect(css).toMatch(/body:has\(\.signin-nudge\) :is\(\.pwa-install, \.notif-optin\) \{ display: none; \}/);
});
