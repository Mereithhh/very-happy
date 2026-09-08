import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  discoverAndClaimRelay,
  RELAY_REFRESH_TIMEOUT_MS,
  probeRelayCandidates,
  RELAY_SWITCH_WIN_ROUNDS,
  selectLowestLatencyRelay,
  selectStableRelay,
  type RelaySwitchTracker,
} from './relaySelection';

const candidates = [
  { id: 'sin', url: 'https://sin.example.com', region: 'Singapore' },
  { id: 'usw', url: 'https://us.example.com', region: 'US West' },
];

describe('relay selection', () => {
  it('selects the lowest measured RTT and preserves config order on a tie', () => {
    expect(selectLowestLatencyRelay(candidates, [{ relayId: 'sin', rttMs: 80 }, { relayId: 'usw', rttMs: 20 }])?.id).toBe('usw');
    expect(selectLowestLatencyRelay(candidates, [{ relayId: 'sin', rttMs: 20 }, { relayId: 'usw', rttMs: 20 }])?.id).toBe('sin');
  });

  it('keeps a connected relay despite a single materially faster or missing probe', () => {
    expect(selectStableRelay(candidates, [
      { relayId: 'sin', rttMs: 600 },
      { relayId: 'usw', rttMs: 20 },
    ], 'sin').candidate?.id).toBe('sin');
    expect(selectStableRelay(candidates, [
      { relayId: 'usw', rttMs: 20 },
    ], 'sin').candidate?.id).toBe('sin');
  });

  it('reselects the fastest healthy relay when disconnected or removed from discovery', () => {
    const probes = [
      { relayId: 'sin', rttMs: 80 },
      { relayId: 'usw', rttMs: 20 },
    ];
    expect(selectStableRelay(candidates, probes).candidate?.id).toBe('usw');
    expect(selectStableRelay(candidates, probes, 'removed').candidate?.id).toBe('usw');
  });

  it('switches only after the same materially faster challenger wins 20 consecutive rounds', () => {
    const probes = [
      { relayId: 'sin', rttMs: 600 },
      { relayId: 'usw', rttMs: 100 },
    ];
    let tracker: RelaySwitchTracker = null;
    for (let round = 1; round < RELAY_SWITCH_WIN_ROUNDS; round++) {
      const decision = selectStableRelay(candidates, probes, 'sin', tracker);
      expect(decision.candidate?.id).toBe('sin');
      expect(decision.tracker?.consecutiveWins).toBe(round);
      tracker = decision.tracker;
    }
    const migration = selectStableRelay(candidates, probes, 'sin', tracker);
    expect(migration.candidate?.id).toBe('usw');
    expect(migration.tracker).toBeNull();
  });

  it('resets the win streak when the advantage is small or the current probe is missing', () => {
    const tracker: RelaySwitchTracker = { challengerRelayId: 'usw', consecutiveWins: 19 };
    expect(selectStableRelay(candidates, [
      { relayId: 'sin', rttMs: 100 },
      { relayId: 'usw', rttMs: 65 },
    ], 'sin', tracker)).toEqual({ candidate: candidates[0], tracker: null });
    expect(selectStableRelay(candidates, [
      { relayId: 'usw', rttMs: 20 },
    ], 'sin', tracker)).toEqual({ candidate: candidates[0], tracker: null });
  });

  it('filters failed and identity-mismatched health responses', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      clock += 5;
      if (String(url).includes('sin')) return new Response(JSON.stringify({ ok: true, relayId: 'sin' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, relayId: 'wrong' }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(probeRelayCandidates(candidates, { fetchImpl, now: () => clock })).resolves.toEqual([
      { relayId: 'sin', rttMs: 10 },
    ]);
  });

  it('selects the faster of two real local health endpoints', async () => {
    const slow = createServer((_request, response) => setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, relayId: 'slow' }));
    }, 80));
    const fast = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, relayId: 'fast' }));
    });
    slow.listen(0, '127.0.0.1');
    fast.listen(0, '127.0.0.1');
    await Promise.all([once(slow, 'listening'), once(fast, 'listening')]);
    try {
      const slowAddress = slow.address();
      const fastAddress = fast.address();
      if (!slowAddress || typeof slowAddress === 'string' || !fastAddress || typeof fastAddress === 'string') throw new Error('missing test address');
      const localCandidates = [
        { id: 'slow', url: `http://127.0.0.1:${slowAddress.port}`, region: 'slow-test' },
        { id: 'fast', url: `http://127.0.0.1:${fastAddress.port}`, region: 'fast-test' },
      ];
      const probes = await probeRelayCandidates(localCandidates, { timeoutMs: 1_000 });
      expect(selectLowestLatencyRelay(localCandidates, probes)?.id).toBe('fast');
    } finally {
      slow.close();
      fast.close();
    }
  });
});


describe('relay refresh deadlines', () => {
  afterEach(() => vi.useRealTimers());
  const input = { controlUrl: 'https://control.test', token: 'test', machineId: 'm1' };
  const assignment = { relayId: 'sin', url: candidates[0].url, region: 'Singapore', token: 'relay-token', expiresAt: 100_000 };
  const response = (body: unknown) => new Response(JSON.stringify(body));

  it.each(['discovery-headers', 'discovery-body', 'claim-headers', 'claim-body'])('bounds %s even when abort is ignored, and discards late results', async (stage) => {
    vi.useFakeTimers();
    let finish!: (value: any) => void;
    const stalled = new Promise<any>((resolve) => { finish = resolve; });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const claim = String(url).endsWith('/claim');
      const discovery = String(url).endsWith('/v1/relays');
      if ((claim && stage.startsWith('claim')) || (discovery && stage.startsWith('discovery'))) {
        return stage.endsWith('headers') ? stalled : { ok: true, json: () => stalled };
      }
      if (discovery) return response({ enabled: true, assignmentTtlMs: 75_000, candidates: [candidates[0]] });
      if (claim) return response({ assignment });
      return response({ ok: true, relayId: 'sin' });
    }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
    const result = discoverAndClaimRelay({ ...input, fetchImpl });
    await vi.advanceTimersByTimeAsync(RELAY_REFRESH_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const lastSignal = fetchImpl.mock.calls.at(-1)?.[1]?.signal;
    expect(lastSignal?.aborted).toBe(true);
    const count = fetchImpl.mock.calls.length;
    const lateBody = stage.startsWith('claim') ? { assignment } : { enabled: true, assignmentTtlMs: 75_000, candidates: [candidates[0]] };
    finish(stage.endsWith('headers') ? response(lateBody) : lateBody);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(count);
  });

  it.each(['headers', 'body'])('bounds candidate %s without abort support and still claims the connected relay', async (stage) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/relays')) return response({ enabled: true, assignmentTtlMs: 75_000, candidates: [candidates[0]] });
      if (String(url).endsWith('/claim')) return response({ assignment });
      const stalled = new Promise<Response>(() => {});
      return stage === 'headers' ? stalled : { ok: true, json: () => stalled } as unknown as Response;
    });
    const result = discoverAndClaimRelay({ ...input, connectedRelayId: 'sin', fetchImpl });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ assignment, probes: [], switchTracker: null });
    expect(fetchImpl.mock.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one overall budget, including discovery time and unfinished probes', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/relays')) {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        return response({ enabled: true, assignmentTtlMs: 75_000, candidates: [candidates[0]] });
      }
      return new Promise<Response>(() => {});
    });
    const result = discoverAndClaimRelay({ ...input, connectedRelayId: 'sin', fetchImpl });
    await vi.advanceTimersByTimeAsync(RELAY_REFRESH_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
