/**
 * B-512: `[SPAWN TIMING]` — where a web "new session" spends its time on the
 * daemon: request → agent homes resolved → wrapper process spawned → the
 * wrapper's session webhook (the moment the spawn RPC can answer).
 */
export type SpawnStage = 'agentHome' | 'spawned';

export interface SpawnTimer {
    mark(stage: SpawnStage): void;
    /** One log line; `end` is the webhook / error time. */
    format(details: { agent: string; outcome: string }, end?: number): string;
}

export function createSpawnTimer(clock: () => number = Date.now): SpawnTimer {
    const requestAt = clock();
    const marks: Partial<Record<SpawnStage, number>> = {};
    return {
        mark(stage) {
            if (marks[stage] === undefined) marks[stage] = clock();
        },
        format({ agent, outcome }, end = clock()) {
            const span = (from: number | undefined, to: number | undefined) =>
                from === undefined || to === undefined ? '-' : `${to - from}ms`;
            const endLabel = outcome === 'success' ? 'webhook' : outcome;
            return `[SPAWN TIMING] agent=${agent} outcome=${outcome} total=${end - requestAt}ms`
                + ` request→agentHome=${span(requestAt, marks.agentHome)}`
                + ` agentHome→spawned=${span(marks.agentHome, marks.spawned)}`
                + ` spawned→${endLabel}=${span(marks.spawned, end)}`;
        },
    };
}
