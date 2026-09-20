import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-462 wiring guard (source assertions). The rules and the banner are unit
 * tested next to them; this pins that SessionDetailScreen actually mounts the
 * banner, and mounts it on the branch where it can be seen — a LIVE session,
 * i.e. exactly where the archived/offline restore banner does NOT apply.
 */
const screen = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');

describe('SessionDetailScreen mounts the stale-wrapper banner', () => {
    it('renders it for a live, non-mirror session', () => {
        expect(screen).toContain("import { StaleWrapperBanner } from './StaleWrapperBanner';");
        expect(screen).toContain('{!mirror && !canOfferRestore(session, bannerMachine) && <StaleWrapperBanner sessionId={id} />}');
    });
});
