import { RelayAssignmentResponseSchema, type RelayAssignment } from '@slopus/happy-wire';

export const RELAY_DISCOVERY_TIMEOUT_MS = 3_000;

/** Bound both headers and body: a reachable HTTP endpoint can still stall its JSON response. */
export async function discoverRelay(url: string, headers: Record<string, string>): Promise<RelayAssignment | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error('relay discovery timeout'));
            controller.abort();
        }, RELAY_DISCOVERY_TIMEOUT_MS);
    });
    try {
        // Race as well as abort so callers are released even if the fetch adapter
        // does not honor cancellation. The late response cannot install a relay.
        return await Promise.race([
            (async () => {
                const response = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error(`relay discovery failed (${response.status})`);
                return RelayAssignmentResponseSchema.parse(await response.json()).assignment;
            })(),
            deadline,
        ]);
    } finally {
        clearTimeout(timer);
    }
}
