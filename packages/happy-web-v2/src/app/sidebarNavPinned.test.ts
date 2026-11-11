// @vitest-environment happy-dom
/** B-926: the pinned entry rows persist per device as a JSON key list; anything else falls back to the default rows. */
import { describe, expect, it } from 'vitest';
import { parseNavPinned, useSidebarPrefs } from './useSidebarPrefs';

describe('navPinned (B-926)', () => {
  it('parses a key list; absent / broken / wrong shape = default (null)', () => {
    expect(parseNavPinned('["issues","people"]')).toEqual(['issues', 'people']);
    expect(parseNavPinned('[]')).toEqual([]);
    expect(parseNavPinned(null)).toBeNull();
    expect(parseNavPinned('{')).toBeNull();
    expect(parseNavPinned('{"a":1}')).toBeNull();
    expect(parseNavPinned('[1,2]')).toBeNull();
  });
  it('setNavPinned writes the list and null clears it', () => {
    useSidebarPrefs.getState().setNavPinned(['teams']);
    expect(localStorage.getItem('vh.sidebar.navPinned')).toBe('["teams"]');
    expect(useSidebarPrefs.getState().navPinned).toEqual(['teams']);
    useSidebarPrefs.getState().setNavPinned(null);
    expect(localStorage.getItem('vh.sidebar.navPinned')).toBeNull();
    expect(useSidebarPrefs.getState().navPinned).toBeNull();
  });
});
