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

export const RELAY_SWITCH_WIN_ROUNDS = 20;
export const RELAY_SWITCH_MIN_ADVANTAGE_MS = 50;
export const RELAY_SWITCH_MIN_ADVANTAGE_RATIO = 0.30;

export type RelaySwitchTracker = {
  challengerRelayId: string;
  consecutiveWins: number;
} | null;

export type StableRelayDecision = {
  candidate: RelayCandidate | null;
  tracker: RelaySwitchTracker;
};

/**
 * Keep an already-connected relay sticky unless another region has a material
 * advantage for many consecutive rounds. A live Socket.IO connection is a
 * stronger health signal than one HTTP probe, and moving it rebuilds RPC
 * registrations and terminal subscriptions.
 *
 * The caller must only pass `connectedRelayId` while that relay socket is
 * actually connected. A disconnect or removal from discovery falls back to
 * the fastest successful probe immediately.
 */
export function selectStableRelay(
  candidates: RelayCandidate[],
  probes: RelayProbe[],
  connectedRelayId?: string,
  tracker: RelaySwitchTracker = null,
): StableRelayDecision {
  const fastest = selectLowestLatencyRelay(candidates, probes);
  if (!connectedRelayId) return { candidate: fastest, tracker: null };

  const connected = candidates.find((candidate) => candidate.id === connectedRelayId);
  if (!connected) return { candidate: fastest, tracker: null };
  if (!fastest || fastest.id === connected.id) return { candidate: connected, tracker: null };

  const rttById = new Map(probes.map((probe) => [probe.relayId, probe.rttMs]));
  const connectedRtt = rttById.get(connected.id);
  const fastestRtt = rttById.get(fastest.id);
  if (connectedRtt === undefined || fastestRtt === undefined) return { candidate: connected, tracker: null };

  const materiallyFaster = connectedRtt - fastestRtt >= RELAY_SWITCH_MIN_ADVANTAGE_MS
    && fastestRtt <= connectedRtt * (1 - RELAY_SWITCH_MIN_ADVANTAGE_RATIO);
  if (!materiallyFaster) return { candidate: connected, tracker: null };

  const consecutiveWins = tracker?.challengerRelayId === fastest.id
    ? tracker.consecutiveWins + 1
    : 1;
  if (consecutiveWins >= RELAY_SWITCH_WIN_ROUNDS) return { candidate: fastest, tracker: null };
  return {
    candidate: connected,
    tracker: { challengerRelayId: fastest.id, consecutiveWins },
  };
}

// Shared 8s budget for discovery headers/body, parallel 2s health probes, and claim
// headers/body. Release relayRefreshInFlight even if an HTTP adapter ignores abort.
export const RELAY_REFRESH_TIMEOUT_MS = 8_000;

async function withinDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new Error('relay request deadline exceeded'));
      controller.abort();
    };
    timer = setTimeout(cancel, timeoutMs);
    parent?.addEventListener('abort', cancel, { once: true });
    if (parent?.aborted) cancel();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
  }
}

export async function probeRelayCandidates(
  candidates: RelayCandidate[],
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number; signal?: AbortSignal } = {},
): Promise<RelayProbe[]> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  const measured = await Promise.all(candidates.map(async (candidate): Promise<RelayProbe | null> => {
    const startedAt = now();
    try {
      return await withinDeadline(timeoutMs, async (signal) => {
        const response = await fetchImpl(`${candidate.url}/health`, {
          method: 'GET',
          cache: 'no-store',
          signal,
        });
        if (!response.ok) return null;
        const body = await response.json() as { ok?: unknown; relayId?: unknown };
        if (body.ok !== true || body.relayId !== candidate.id) return null;
        return { relayId: candidate.id, rttMs: Math.max(0, now() - startedAt) };
      }, options.signal);
    } catch {
      return null;
    }
  }));
  return measured.filter((probe): probe is RelayProbe => probe !== null);
}

export async function discoverAndClaimRelay(input: {
  controlUrl: string;
  token: string;
  machineId: string;
  connectedRelayId?: string;
  switchTracker?: RelaySwitchTracker;
  fetchImpl?: typeof fetch;
}): Promise<{ assignment: RelayAssignment; probes: RelayProbe[]; switchTracker: RelaySwitchTracker } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    return await withinDeadline(RELAY_REFRESH_TIMEOUT_MS, async (signal) => {
      const discoveryResponse = await fetchImpl(`${input.controlUrl}/v1/relays`, {
        headers: { Authorization: `Bearer ${input.token}` },
        cache: 'no-store',
        signal,
      });
      if (!discoveryResponse.ok) return null;
      const discovery = RelayCandidatesResponseSchema.parse(await discoveryResponse.json());
      signal.throwIfAborted();
      if (!discovery.enabled || discovery.candidates.length === 0) return null;
      const probes = await probeRelayCandidates(discovery.candidates, { fetchImpl, signal });
      signal.throwIfAborted();
      const decision = selectStableRelay(discovery.candidates, probes, input.connectedRelayId, input.switchTracker);
      const selected = decision.candidate;
      if (!selected) return null;
      const claimResponse = await fetchImpl(`${input.controlUrl}/v1/relays/machines/${encodeURIComponent(input.machineId)}/claim`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ relayId: selected.id, probes }),
      });
      if (!claimResponse.ok) return null;
      const claimed = RelayAssignmentResponseSchema.parse(await claimResponse.json());
      signal.throwIfAborted();
      return claimed.assignment ? { assignment: claimed.assignment, probes, switchTracker: decision.tracker } : null;
    });
  } catch {
    return null;
  }
}
