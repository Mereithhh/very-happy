import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('lets mobile fullscreen override both desktop notification anchor directions', () => {
  const css = readFileSync(new URL('./notifications.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 799px)'));
  // The data-up selector otherwise wins specificity and leaves a short panel
  // floating above the footer instead of filling the mobile viewport.
  const rule = mobile.match(/\.nc-panel,\s*\.nc-panel\[data-up='true'\]\s*\{([^}]+)\}/)?.[1];
  expect(rule).toBeDefined();
  for (const declaration of ['top: 0;', 'bottom: 0;', 'max-height: none;']) {
    expect(rule).toContain(declaration);
  }
});
