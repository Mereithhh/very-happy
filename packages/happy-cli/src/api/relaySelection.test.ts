import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probeRelayCandidates, selectLowestLatencyRelay, selectStableRelay } from './relaySelection';

const candidates = [
  { id: 'sin', url: 'https://sin.example.com', region: 'Singapore' },
  { id: 'usw', url: 'https://us.example.com', region: 'US West' },
];

describe('relay selection', () => {
  it('selects the lowest measured RTT and preserves config order on a tie', () => {
    expect(selectLowestLatencyRelay(candidates, [{ relayId: 'sin', rttMs: 80 }, { relayId: 'usw', rttMs: 20 }])?.id).toBe('usw');
    expect(selectLowestLatencyRelay(candidates, [{ relayId: 'sin', rttMs: 20 }, { relayId: 'usw', rttMs: 20 }])?.id).toBe('sin');
  });

  it('keeps a connected relay despite a slower or missing one-shot health probe', () => {
    expect(selectStableRelay(candidates, [
      { relayId: 'sin', rttMs: 600 },
      { relayId: 'usw', rttMs: 20 },
    ], 'sin')?.id).toBe('sin');
    expect(selectStableRelay(candidates, [
      { relayId: 'usw', rttMs: 20 },
    ], 'sin')?.id).toBe('sin');
  });

  it('reselects the fastest healthy relay when disconnected or removed from discovery', () => {
    const probes = [
      { relayId: 'sin', rttMs: 80 },
      { relayId: 'usw', rttMs: 20 },
    ];
    expect(selectStableRelay(candidates, probes)?.id).toBe('usw');
    expect(selectStableRelay(candidates, probes, 'removed')?.id).toBe('usw');
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
