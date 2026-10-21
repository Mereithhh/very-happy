import { describe, expect, it } from 'vitest';
import { hasUserGesture, spawnRoutePattern } from './spawnOrigin';

describe('B-723 (O5) spawn origin', () => {
  it('keeps the route shape and drops ids', () => {
    expect(spawnRoutePattern('/teams/64f8be66c1826ee7885fb4e91702efa88475be2646b826e059d1567c42bf3a46')).toBe('/teams/:id');
    expect(spawnRoutePattern('/session/cmvi6y5cn0639p92kb94ib6kn/files')).toBe('/session/:id/files');
    expect(spawnRoutePattern('/')).toBe('/');
    expect(spawnRoutePattern('/help')).toBe('/help');
  });
  it('the quick path needs a live user gesture; browsers without the API are trusted', () => {
    expect(hasUserGesture({ userActivation: { isActive: true } })).toBe(true);
    expect(hasUserGesture({ userActivation: { isActive: false } })).toBe(false);
    expect(hasUserGesture({})).toBe(true);
    expect(hasUserGesture(undefined)).toBe(true);
  });
});
