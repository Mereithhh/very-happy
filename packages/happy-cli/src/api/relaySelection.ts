import {
  RelayAssignmentResponseSchema,
  RelayCandidatesResponseSchema,
  type RelayAssignment,
  type RelayCandidate,
  type RelayProbe,
} from '@slopus/happy-wire';

export function selectLowestLatencyRelay(candidates: RelayCandidate[], probes: RelayProbe[]): RelayCandidate | null {
  const rttById = new Map(probes.map((probe) => [probe.relayId, probe.rttMs]));
  let selected: RelayCandidate | null = null;
  let selectedRtt = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rtt = rttById.get(candidate.id);
    if (rtt === undefined || !Number.isFinite(rtt) || rtt < 0) continue;
    if (rtt < selectedRtt) {
      selected = candidate;
      selectedRtt = rtt;
    }
  }
  return selected;
}

/**
 * Keep an already-connected relay sticky. A live Socket.IO connection is a
 * stronger health signal than a single HTTP probe, and moving it rebuilds RPC
 * registrations and terminal subscriptions. The caller must only pass
 * `connectedRelayId` while that relay socket is actually connected.
 *
 * If the connected relay was removed from discovery, fall back to the fastest
 * successful probe so configuration changes still take effect immediately.
 */
export function selectStableRelay(
  candidates: RelayCandidate[],
  probes: RelayProbe[],
  connectedRelayId?: string,
): RelayCandidate | null {
  if (connectedRelayId) {
    const connected = candidates.find((candidate) => candidate.id === connectedRelayId);
    if (connected) return connected;
  }
  return selectLowestLatencyRelay(candidates, probes);
}

export async function probeRelayCandidates(
  candidates: RelayCandidate[],
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RelayProbe[]> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const measured = await Promise.all(candidates.map(async (candidate): Promise<RelayProbe | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
    try {
      const response = await fetchImpl(`${candidate.url}/health`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json() as { ok?: unknown; relayId?: unknown };
      if (body.ok !== true || body.relayId !== candidate.id) return null;
      return { relayId: candidate.id, rttMs: Math.max(0, now() - startedAt) };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }));
  return measured.filter((probe): probe is RelayProbe => probe !== null);
}

export async function discoverAndClaimRelay(input: {
  controlUrl: string;
  token: string;
  machineId: string;
  connectedRelayId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ assignment: RelayAssignment; probes: RelayProbe[] } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const discoveryResponse = await fetchImpl(`${input.controlUrl}/v1/relays`, {
      headers: { Authorization: `Bearer ${input.token}` },
      cache: 'no-store',
    });
    if (!discoveryResponse.ok) return null;
    const discovery = RelayCandidatesResponseSchema.parse(await discoveryResponse.json());
    if (!discovery.enabled || discovery.candidates.length === 0) return null;
    const probes = await probeRelayCandidates(discovery.candidates, { fetchImpl });
    const selected = selectStableRelay(discovery.candidates, probes, input.connectedRelayId);
    if (!selected) return null;
    const claimResponse = await fetchImpl(`${input.controlUrl}/v1/relays/machines/${encodeURIComponent(input.machineId)}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayId: selected.id, probes }),
    });
    if (!claimResponse.ok) return null;
    const claimed = RelayAssignmentResponseSchema.parse(await claimResponse.json());
    return claimed.assignment ? { assignment: claimed.assignment, probes } : null;
  } catch {
    return null;
  }
}
