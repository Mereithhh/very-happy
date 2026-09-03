/** B-353: `Spawned session <id> … https://…/session/<id>` (assistantTools.ts) → session id for the link chip; else null. */
export function spawnedSessionIdOf(resultText: string, inputSessionId?: unknown): string | null {
    const fromText = /\/session\/([A-Za-z0-9_-]{8,})/.exec(resultText)?.[1]
        ?? /Spawned session ([A-Za-z0-9_-]{8,})/.exec(resultText)?.[1];
    if (fromText) return fromText;
    return typeof inputSessionId === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(inputSessionId) ? inputSessionId : null;
}
