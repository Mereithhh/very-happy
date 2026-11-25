import { describe, expect, it } from 'vitest';
import { PLUGIN_FRAME_ALLOW, PLUGIN_FRAME_REFERRER_POLICY, PLUGIN_FRAME_SANDBOX, ticketUrlAllowed } from './pluginFrame';

describe('plugin frame attributes (§4.1)', () => {
  it('sandbox is exactly the approved set', () => {
    expect(PLUGIN_FRAME_SANDBOX.split(' ').sort()).toEqual(['allow-downloads', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin', 'allow-scripts']);
    for (const banned of ['allow-top-navigation', 'allow-modals', 'allow-storage-access-by-user-activation', 'allow-top-navigation-by-user-activation']) expect(PLUGIN_FRAME_SANDBOX).not.toContain(banned);
    expect(PLUGIN_FRAME_ALLOW).toBe('');
    expect(PLUGIN_FRAME_REFERRER_POLICY).toBe('no-referrer');
  });

  it('ticket URL must be the install origin at /__vh/enter', () => {
    const o = 'https://hello-board-abcd1234.p.example.test';
    expect(ticketUrlAllowed(`${o}/__vh/enter?t=x&p=%2F`, o)).toBe(true);
    expect(ticketUrlAllowed('https://other-ffff0000.p.example.test/__vh/enter?t=x', o)).toBe(false);
    expect(ticketUrlAllowed(`${o}/elsewhere?t=x`, o)).toBe(false);
    expect(ticketUrlAllowed('http://hello-board-abcd1234.p.example.test/__vh/enter?t=x', o)).toBe(false);
    expect(ticketUrlAllowed('javascript:alert(1)', o)).toBe(false);
    expect(ticketUrlAllowed('http://hello-abc.localhost:8080/__vh/enter?t=x', 'http://hello-abc.localhost:8080')).toBe(true);
  });
});

import { withPathFragment } from './pluginFrame';
describe('panelPath fragment (r3)', () => {
  it('keeps the fragment on the iframe URL', () => {
    expect(withPathFragment('https://o.test/__vh/enter?t=1&p=%2Fa%23x', '/a#x')).toBe('https://o.test/__vh/enter?t=1&p=%2Fa%23x#x');
    expect(withPathFragment('https://o.test/__vh/enter?t=1', '/a')).toBe('https://o.test/__vh/enter?t=1');
    expect(withPathFragment('https://o.test/__vh/enter?t=1#y', '/a#x')).toBe('https://o.test/__vh/enter?t=1#y');
    expect(withPathFragment('https://o.test/__vh/enter?t=1', null)).toBe('https://o.test/__vh/enter?t=1');
  });
});
