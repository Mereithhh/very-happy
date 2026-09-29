import { describe, expect, it } from 'vitest';
import { createSpawnTimer } from './spawnTiming';

describe('createSpawnTimer (B-512)', () => {
    it('reports each stage in ms', () => {
        const times = [1000, 1003, 1043, 1812];
        const timer = createSpawnTimer(() => times.shift()!);
        timer.mark('agentHome');
        timer.mark('spawned');
        expect(timer.format({ agent: 'claude', outcome: 'success' })).toBe(
            '[SPAWN TIMING] agent=claude outcome=success total=812ms request→agentHome=3ms agentHome→spawned=40ms spawned→webhook=769ms',
        );
    });

    it('keeps the first mark and shows missing stages as -', () => {
        const times = [0, 5, 9, 20];
        const timer = createSpawnTimer(() => times.shift()!);
        timer.mark('agentHome');
        timer.mark('agentHome');
        expect(timer.format({ agent: 'codex', outcome: 'error' }, 20)).toBe(
            '[SPAWN TIMING] agent=codex outcome=error total=20ms request→agentHome=5ms agentHome→spawned=- spawned→error=-',
        );
    });
});
