import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installSwUpdateReload } from './swUpdateReload';

function container() {
  const listeners: Array<() => void> = [];
  return {
    addEventListener: (type: string, listener: () => void) => { if (type === 'controllerchange') listeners.push(listener); },
    fire: () => listeners.forEach((l) => l()),
  };
}

describe('B-823 reload onto the new shell when a new worker takes over', () => {
  it('a page controlled at boot reloads once, after flushing (drafts, notice, unload guard)', () => {
    const c = container();
    const order: string[] = [];
    installSwUpdateReload({ container: c as never, controlledAtBoot: true, beforeReload: () => order.push('before'), reload: () => order.push('reload') });
    c.fire();
    c.fire();
    expect(order).toEqual(['before', 'reload']);
  });

  it('a first visit (no controller at boot: clients.claim adopts the page) never reloads', () => {
    const c = container();
    const reload = vi.fn();
    installSwUpdateReload({ container: c as never, controlledAtBoot: false, beforeReload: vi.fn(), reload });
    c.fire();
    expect(reload).not.toHaveBeenCalled();
  });

  it('no service worker support: nothing to install', () => {
    expect(() => installSwUpdateReload({ container: undefined, controlledAtBoot: false, beforeReload: vi.fn(), reload: vi.fn() })).not.toThrow();
  });

  it('main.tsx wires it with the boot controller and the update-reload preparation', () => {
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');
    expect(main).toContain('controlledAtBoot: Boolean(navigator.serviceWorker?.controller),');
    expect(main).toContain('beforeReload: () => { prepareForUpdateReload(); markProgrammaticReload(); },');
    expect(main).toContain('reload: () => window.location.reload(),');
  });
});
