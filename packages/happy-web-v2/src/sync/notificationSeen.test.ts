import { describe, it, expect } from 'vitest';
import {
    mergeSeenMaps,
    isEntryUnread,
    isSeenAt,
    isUnreadBySeen,
    parseSeenMap,
    planSeenWrites,
    pruneSeenMap,
    pushSeenWithCas,
    seenMapsEqual,
    targetKeyOfPath,
    systemNotificationMatchesKey,
    SEEN_MAX_AGE_MS,
    SEEN_MAX_KEYS,
    type SeenMap,
} from './notificationSeen';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('isUnreadBySeen', () => {
    it('an entry older than the target lastSeenAt is read', () => {
        const seen: SeenMap = { s1: NOW };
        expect(isUnreadBySeen({ key: 's1', createdAt: NOW - 1000 }, seen)).toBe(false);
    });

    it('an entry newer than lastSeenAt stays unread', () => {
        const seen: SeenMap = { s1: NOW - 1000 };
        expect(isUnreadBySeen({ key: 's1', createdAt: NOW }, seen)).toBe(true);
    });

    it('same-millisecond entry counts as seen (lastSeenAt >= createdAt)', () => {
        expect(isUnreadBySeen({ key: 's1', createdAt: NOW }, { s1: NOW })).toBe(false);
    });

    it('an unknown key is never "read" — empty map reproduces legacy behavior', () => {
        expect(isUnreadBySeen({ key: 's1', createdAt: NOW }, {})).toBe(true);
        expect(isUnreadBySeen({ key: 's1', createdAt: 1 }, { other: NOW })).toBe(true);
    });

    it('terminal keys are namespaced and do not bleed into session keys', () => {
        const seen: SeenMap = { 't:term-1': NOW };
        expect(isUnreadBySeen({ key: 't:term-1', createdAt: NOW - 5 }, seen)).toBe(false);
        expect(isUnreadBySeen({ key: 'term-1', createdAt: NOW - 5 }, seen)).toBe(true);
    });

    it('isSeenAt is the same predicate, inverted', () => {
        expect(isSeenAt({ s1: NOW }, 's1', NOW - 1)).toBe(true);
        expect(isSeenAt({ s1: NOW }, 's1', NOW + 1)).toBe(false);
        expect(isSeenAt({}, 's1', NOW)).toBe(false);
    });
});

describe('isEntryUnread (the AND with the per-device legacy flag)', () => {
    const entry = { key: 's1', createdAt: NOW };

    it('the synced map alone can retire an entry the device thinks is unread', () => {
        expect(isEntryUnread(true, entry, { s1: NOW + 1 })).toBe(false);
    });

    it('the device flag alone can retire an entry the synced map knows nothing about', () => {
        expect(isEntryUnread(false, entry, {})).toBe(false);
    });

    it('unread requires BOTH sides to say unread', () => {
        expect(isEntryUnread(true, entry, {})).toBe(true);
        expect(isEntryUnread(true, entry, { s1: NOW - 1 })).toBe(true);
    });

    it('an empty map degrades to exactly the pre-feature behavior', () => {
        for (const legacy of [true, false]) {
            expect(isEntryUnread(legacy, entry, {})).toBe(legacy);
        }
    });
});

describe('mergeSeenMaps', () => {
    it('takes the later timestamp per key and unions key sets', () => {
        const a: SeenMap = { s1: NOW, s2: NOW - 5000 };
        const b: SeenMap = { s1: NOW - 9000, s3: NOW - 1000 };
        expect(mergeSeenMaps(a, b)).toEqual({ s1: NOW, s2: NOW - 5000, s3: NOW - 1000 });
    });

    it('is commutative — merge order cannot change the result', () => {
        const a: SeenMap = { s1: NOW, s2: NOW - 3 };
        const b: SeenMap = { s1: NOW - 1, s2: NOW - 2, s3: 7 };
        expect(mergeSeenMaps(a, b)).toEqual(mergeSeenMaps(b, a));
    });

    it('is idempotent — replaying an update is a no-op', () => {
        const a: SeenMap = { s1: NOW, s2: NOW - 10 };
        const once = mergeSeenMaps(a, { s1: NOW + 5 });
        expect(mergeSeenMaps(once, { s1: NOW + 5 })).toEqual(once);
    });

    it('is associative', () => {
        const a: SeenMap = { s1: 3, s2: 1 };
        const b: SeenMap = { s1: 5, s3: 2 };
        const c: SeenMap = { s2: 9, s3: 1 };
        expect(mergeSeenMaps(mergeSeenMaps(a, b), c)).toEqual(mergeSeenMaps(a, mergeSeenMaps(b, c)));
    });

    it('does not mutate its inputs', () => {
        const a: SeenMap = { s1: 1 };
        const b: SeenMap = { s1: 2, s2: 3 };
        mergeSeenMaps(a, b);
        expect(a).toEqual({ s1: 1 });
        expect(b).toEqual({ s1: 2, s2: 3 });
    });
});

describe('seenMapsEqual', () => {
    it('compares keys and timestamps', () => {
        expect(seenMapsEqual({ s1: 1 }, { s1: 1 })).toBe(true);
        expect(seenMapsEqual({}, {})).toBe(true);
        expect(seenMapsEqual({ s1: 1 }, { s1: 2 })).toBe(false);
        expect(seenMapsEqual({ s1: 1 }, { s1: 1, s2: 1 })).toBe(false);
        expect(seenMapsEqual({ s1: 1, s2: 1 }, { s1: 1 })).toBe(false);
        expect(seenMapsEqual({ s1: 1 }, { s2: 1 })).toBe(false);
    });

    it('a merge that changed nothing is detectably equal (no push needed)', () => {
        const local: SeenMap = { s1: NOW };
        const remote: SeenMap = { s1: NOW };
        expect(seenMapsEqual(mergeSeenMaps(local, remote), remote)).toBe(true);
    });

    it('a merge that added local knowledge is unequal (push needed)', () => {
        const local: SeenMap = { s1: NOW, s2: NOW };
        const remote: SeenMap = { s1: NOW };
        expect(seenMapsEqual(mergeSeenMaps(local, remote), remote)).toBe(false);
    });
});

describe('two-device concurrency converges', () => {
    /**
     * Device A opens session s1, device B opens session s2, both while offline
     * from each other. Each then does the read-merge-write CAS dance against
     * the shared blob. Whoever loses the version race merges the winner's map
     * instead of overwriting it — the documented failure mode of a whole-table
     * LWW carrier (settings) is exactly what this prevents.
     */
    it('interleaved writes end with BOTH devices read, on both devices', () => {
        const server: SeenMap = { s0: NOW - DAY };

        // both devices start from the same server snapshot
        let a = mergeSeenMaps({}, server);
        let b = mergeSeenMaps({}, server);

        a = planSeenWrites(a, ['s1'], NOW)!;
        b = planSeenWrites(b, ['s2'], NOW + 10)!;

        // A wins the CAS race and lands its blob
        let stored = a;
        // B's push conflicts; it merges the stored value and retries
        b = mergeSeenMaps(b, stored);
        stored = b;
        // A then learns the new value (live kv push / refetch) and merges
        a = mergeSeenMaps(a, stored);

        const expected = { s0: NOW - DAY, s1: NOW, s2: NOW + 10 };
        expect(a).toEqual(expected);
        expect(b).toEqual(expected);
        expect(stored).toEqual(expected);
    });

    it('the loser of a race never rolls the winner back', () => {
        // A saw s1 late, B saw s1 early; B's stale write must not win
        const a: SeenMap = { s1: NOW };
        const b: SeenMap = { s1: NOW - 60_000 };
        expect(mergeSeenMaps(b, a).s1).toBe(NOW);
        expect(mergeSeenMaps(a, b).s1).toBe(NOW);
    });

    it('the same entry is read on both devices after convergence', () => {
        const entry = { key: 's1', createdAt: NOW - 1000 };
        const a = planSeenWrites({}, ['s1'], NOW)!;
        const b = mergeSeenMaps({}, a);
        expect(isUnreadBySeen(entry, a)).toBe(false);
        expect(isUnreadBySeen(entry, b)).toBe(false);
    });
});

describe('planSeenWrites', () => {
    it('stamps every requested key', () => {
        expect(planSeenWrites({}, ['s1', 't:x'], NOW)).toEqual({ s1: NOW, 't:x': NOW });
    });

    it('returns null when nothing moves forward (skip the KV push)', () => {
        expect(planSeenWrites({ s1: NOW }, ['s1'], NOW - 1)).toBeNull();
        expect(planSeenWrites({ s1: NOW }, ['s1'], NOW)).toBeNull();
        expect(planSeenWrites({ s1: NOW }, [], NOW + 1)).toBeNull();
    });

    it('never moves a timestamp backwards (lagging clock / replay)', () => {
        const seen: SeenMap = { s1: NOW, s2: NOW };
        const next = planSeenWrites(seen, ['s1', 's2'], NOW - 5_000);
        expect(next).toBeNull();
    });

    it('advances only the keys that need it', () => {
        const seen: SeenMap = { s1: NOW + 1000, s2: NOW - 1000 };
        expect(planSeenWrites(seen, ['s1', 's2'], NOW)).toEqual({ s1: NOW + 1000, s2: NOW });
    });

    it('ignores empty keys and does not mutate the input', () => {
        const seen: SeenMap = { s1: 1 };
        expect(planSeenWrites(seen, [''], NOW)).toBeNull();
        expect(seen).toEqual({ s1: 1 });
    });
});

describe('pruneSeenMap', () => {
    it('drops keys older than the age cutoff, keeps the rest', () => {
        const seen: SeenMap = { old: NOW - 60 * DAY, fresh: NOW - DAY };
        expect(pruneSeenMap(seen, NOW)).toEqual({ fresh: NOW - DAY });
    });

    it('the age cutoff is wider than the widest retention window (30d)', () => {
        expect(SEEN_MAX_AGE_MS).toBeGreaterThan(30 * DAY);
    });

    it('pruning an aged-out key cannot resurrect a visible entry', () => {
        // A key is only prunable when its lastSeenAt is ≥45 days old; every
        // entry still inside the ≤30-day retention window is newer than that,
        // so it was ALREADY unread before the prune. Verdict is unchanged.
        const seen: SeenMap = { s1: NOW - 50 * DAY };
        const visible = { key: 's1', createdAt: NOW - 29 * DAY }; // still in retention
        expect(isUnreadBySeen(visible, seen)).toBe(true);
        const pruned = pruneSeenMap(seen, NOW);
        expect(pruned).toEqual({});
        expect(isUnreadBySeen(visible, pruned)).toBe(true);
    });

    it('keeps entries whose lastSeenAt still covers a visible entry', () => {
        const seen: SeenMap = { s1: NOW - 2 * DAY };
        const entry = { key: 's1', createdAt: NOW - 3 * DAY };
        const pruned = pruneSeenMap(seen, NOW);
        expect(isUnreadBySeen(entry, pruned)).toBe(false);
    });

    it('caps the map at maxKeys, keeping the most recently seen targets', () => {
        const seen: Record<string, number> = {};
        for (let i = 0; i < 10; i++) seen[`s${i}`] = NOW - i * 1000;
        const pruned = pruneSeenMap(seen, NOW, SEEN_MAX_AGE_MS, 3);
        expect(Object.keys(pruned).sort()).toEqual(['s0', 's1', 's2']);
    });

    it('cap eviction is deterministic on ties', () => {
        const seen: SeenMap = { b: NOW, a: NOW, c: NOW };
        expect(Object.keys(pruneSeenMap(seen, NOW, SEEN_MAX_AGE_MS, 2)).sort()).toEqual(['a', 'b']);
    });

    it('leaves a small map untouched and tolerates future timestamps', () => {
        const seen: SeenMap = { s1: NOW + 10 * DAY };
        expect(pruneSeenMap(seen, NOW)).toEqual(seen);
    });

    it('default cap matches the documented constant', () => {
        const seen: Record<string, number> = {};
        for (let i = 0; i < SEEN_MAX_KEYS + 5; i++) seen[`s${i}`] = NOW - i;
        expect(Object.keys(pruneSeenMap(seen, NOW)).length).toBe(SEEN_MAX_KEYS);
    });
});

describe('pushSeenWithCas', () => {
    /** A minimal stand-in for the account KV blob: one value + one version. */
    function fakeServer(initial: SeenMap = {}, version = -1) {
        return {
            value: initial,
            version,
            put(value: SeenMap, atVersion: number) {
                if (atVersion !== this.version) {
                    return { ok: false as const, version: this.version, remote: this.value };
                }
                this.value = value;
                this.version = this.version + 1;
                return { ok: true as const, version: this.version };
            },
        };
    }

    /** A device: local map + believed version, wired to a fake server. */
    function device(server: ReturnType<typeof fakeServer>, seen: SeenMap = {}, version = -1) {
        const state = { seen, version, absorbed: 0 };
        return {
            state,
            markSeen(keys: string[], at: number) {
                state.seen = planSeenWrites(state.seen, keys, at) ?? state.seen;
            },
            push(maxAttempts = 4) {
                return pushSeenWithCas(
                    {
                        read: () => state.seen,
                        version: () => state.version,
                        write: async (value, v) => server.put(value, v),
                        absorb: (remote, v) => {
                            state.absorbed++;
                            state.seen = mergeSeenMaps(state.seen, remote);
                            state.version = v;
                        },
                    },
                    maxAttempts,
                );
            },
        };
    }

    it('writes on the first try when nobody raced us', async () => {
        const server = fakeServer();
        const a = device(server);
        a.markSeen(['s1'], NOW);
        await expect(a.push()).resolves.toEqual({ status: 'written', version: 0 });
        expect(server.value).toEqual({ s1: NOW });
        expect(a.state.absorbed).toBe(0);
    });

    it('two devices racing: the loser merges the winner and both end whole', async () => {
        const server = fakeServer();
        const a = device(server);
        const b = device(server);

        a.markSeen(['s1'], NOW);
        b.markSeen(['s2'], NOW + 5);

        // A lands first; B's CAS fails once, absorbs, retries and lands.
        await a.push();
        const outcome = await b.push();

        expect(outcome.status).toBe('written');
        expect(b.state.absorbed).toBe(1);
        expect(server.value).toEqual({ s1: NOW, s2: NOW + 5 });
        // …and A converges as soon as it hears the new value.
        a.state.seen = mergeSeenMaps(a.state.seen, server.value);
        expect(a.state.seen).toEqual(server.value);
    });

    it('a conflicting write NEVER rolls back the other device (no lost reads)', async () => {
        // Server already knows s1 was seen late; our stale device only knows an
        // earlier s1 plus a fresh s2.
        const server = fakeServer({ s1: NOW }, 3);
        const stale = device(server, { s1: NOW - 60_000 }, -1);
        stale.markSeen(['s2'], NOW + 1);
        await stale.push();
        expect(server.value).toEqual({ s1: NOW, s2: NOW + 1 });
    });

    it('gives up after maxAttempts when a third party keeps winning', async () => {
        const server = fakeServer();
        const a = device(server);
        a.markSeen(['s1'], NOW);
        // Every write is beaten by a phantom device bumping the version.
        let phantom = 0;
        const outcome = await pushSeenWithCas(
            {
                read: () => a.state.seen,
                version: () => a.state.version,
                write: async () => ({
                    ok: false as const,
                    version: phantom++,
                    remote: { [`p${phantom}`]: NOW },
                }),
                absorb: (remote, v) => {
                    a.state.seen = mergeSeenMaps(a.state.seen, remote);
                    a.state.version = v;
                },
            },
            3,
        );
        expect(outcome).toEqual({ status: 'exhausted' });
        // Local state still holds our own read plus everything we absorbed.
        expect(a.state.seen.s1).toBe(NOW);
    });

    it('reports transport errors without retrying (apiKv already backs off)', async () => {
        const boom = new Error('offline');
        let calls = 0;
        const outcome = await pushSeenWithCas(
            {
                read: () => ({ s1: NOW }),
                version: () => -1,
                write: async () => {
                    calls++;
                    throw boom;
                },
                absorb: () => {
                    throw new Error('must not absorb on a transport failure');
                },
            },
            4,
        );
        expect(outcome).toEqual({ status: 'error', error: boom });
        expect(calls).toBe(1);
    });

    it('a deleted/empty remote blob is treated as "nothing known", not as read', async () => {
        const server = fakeServer({}, 7); // exists, empty (e.g. tombstoned)
        const a = device(server, { s1: NOW }, -1);
        await a.push();
        expect(server.value).toEqual({ s1: NOW });
        expect(isUnreadBySeen({ key: 's1', createdAt: NOW - 1 }, server.value)).toBe(false);
    });
});

describe('parseSeenMap', () => {
    it('accepts both the wrapped blob and a bare map', () => {
        expect(parseSeenMap({ seen: { s1: NOW } })).toEqual({ s1: NOW });
        expect(parseSeenMap({ s1: NOW })).toEqual({ s1: NOW });
    });

    it('drops junk values and junk shapes without throwing', () => {
        expect(parseSeenMap({ seen: { s1: 'nope', s2: NOW, s3: -1, s4: NaN } })).toEqual({ s2: NOW });
        expect(parseSeenMap(null)).toEqual({});
        expect(parseSeenMap(undefined)).toEqual({});
        expect(parseSeenMap('x')).toEqual({});
        expect(parseSeenMap([1, 2])).toEqual({});
        expect(parseSeenMap({ seen: [1, 2] })).toEqual({});
    });

    it('a future-version blob with extra fields still yields its seen map', () => {
        expect(parseSeenMap({ seen: { s1: NOW }, somethingNew: 42 })).toEqual({ s1: NOW });
    });
});

describe('targetKeyOfPath', () => {
    it('maps a session route to its id', () => {
        expect(targetKeyOfPath('/session/abc123', '')).toBe('abc123');
    });

    it('maps a terminal route to the tid-namespaced key', () => {
        expect(targetKeyOfPath('/terminal/machine-1', '?tid=term-9')).toBe('t:term-9');
        expect(targetKeyOfPath('/terminal/machine-1', 'tid=term-9')).toBe('t:term-9');
    });

    it('a terminal route without tid has no target (picker / no tab yet)', () => {
        expect(targetKeyOfPath('/terminal/machine-1', '')).toBeNull();
        expect(targetKeyOfPath('/terminal', '')).toBeNull();
    });

    it('non-target routes yield null', () => {
        expect(targetKeyOfPath('/', '')).toBeNull();
        expect(targetKeyOfPath('/board', '')).toBeNull();
        expect(targetKeyOfPath('/settings/notifications', '')).toBeNull();
        expect(targetKeyOfPath('/session', '')).toBeNull();
        expect(targetKeyOfPath('/session/a/b', '')).toBeNull();
    });

    it('tolerates trailing slashes and percent-encoding', () => {
        expect(targetKeyOfPath('/session/abc123/', '')).toBe('abc123');
        expect(targetKeyOfPath('/session/a%20b', '')).toBe('a b');
    });
});

describe('systemNotificationMatchesKey', () => {
    it('matches a foreground notification by its session tag', () => {
        expect(systemNotificationMatchesKey({ tag: 's1' }, 's1')).toBe(true);
        expect(systemNotificationMatchesKey({ tag: 's2' }, 's1')).toBe(false);
    });

    it('matches a Web Push notification by data.url', () => {
        expect(systemNotificationMatchesKey({ data: { url: '/session/s1' } }, 's1')).toBe(true);
        expect(
            systemNotificationMatchesKey({ data: { url: '/terminal/m1?tid=t9' } }, 't:t9'),
        ).toBe(true);
        expect(
            systemNotificationMatchesKey({ data: { url: '/terminal/m1?tid=other' } }, 't:t9'),
        ).toBe(false);
    });

    it('never matches on missing/garbage payloads', () => {
        expect(systemNotificationMatchesKey({}, 's1')).toBe(false);
        expect(systemNotificationMatchesKey({ tag: '' }, 's1')).toBe(false);
        expect(systemNotificationMatchesKey({ data: null }, 's1')).toBe(false);
        expect(systemNotificationMatchesKey({ data: { url: 42 } }, 's1')).toBe(false);
        expect(systemNotificationMatchesKey({ data: { url: '/board' } }, 's1')).toBe(false);
    });
});
