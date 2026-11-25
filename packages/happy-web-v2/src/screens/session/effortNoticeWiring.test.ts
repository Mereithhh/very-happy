import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// B-975: the notice and the landing hold are only as good as their wiring.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('effort downgrade wiring (B-975)', () => {
    it('the composer shows the notice and picks what the next message sends', () => {
        const src = read('./AgentInput.tsx');
        expect(src).toContain('data-testid="effort-unsupported">{effortNotice}</div>');
        expect(src).toContain('session ? codexEffortDowngrade(session, runSettings, latestTable)');
        expect(src).toMatch(/codexSendEffort,\n\s+pending \? pending\.effortLevel/);
        expect(src).toContain("if (effortDowngrade) pending.onMode('effortLevel', effortDowngrade.actual);");
    });
    it('a landing session re-checks before its first message', () => {
        const src = read('../../sync/pendingSessionsRuntime.ts');
        expect(src).toContain('session ? codexEffortDowngrade(session, settings) : null');
        expect(src).toContain("t('pendingSession.effortHeld'");
    });
});
