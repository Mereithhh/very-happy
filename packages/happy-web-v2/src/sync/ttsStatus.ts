/**
 * Pure classifier for a non-2xx TTS HTTP status (unit-tested; B-051 W3).
 * Kept dependency-free on purpose — apiVoice.ts drags in the socket/persistence
 * graph, which pure logic tests must not pay for.
 *
 * The server normalizes UPSTREAM (ElevenLabs) failures to 502/429, so the only
 * statuses that mean "this deployment has no TTS" are:
 *  - 404: route does not exist → old server;
 *  - 501: server explicitly says voice is not configured.
 * Those degrade to sticky pure-text mode. EVERYTHING else is transient — skip
 * the current utterance but keep voice mode (a flaky upstream must never
 * permanently mute the assistant).
 */
export function classifyTtsErrorStatus(status: number): 'unsupported' | 'rate-limited' | 'error' {
    if (status === 404 || status === 501) return 'unsupported';
    if (status === 429) return 'rate-limited';
    return 'error';
}
