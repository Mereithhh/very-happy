import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-719 review: the daemon wiring that keeps a harness install and the CLI's own update apart.
const run = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');

describe('harness install ↔ CLI update wiring (B-719)', () => {
    it('a harness install refuses during the CLI install and during the handover preflight', () => {
        expect(run).toContain('cliUpdateBusy: () => updateController.isRunning() || handoverInFlight,');
        expect(run).toContain('handoverInFlight = true;');
        expect(run).toContain('} finally { handoverInFlight = false; }');
    });
    it('the CLI install and both handover gates wait for a harness install', () => {
        expect(run).toContain('&& !harnessInstaller?.isRunning(),');
        expect(run).toContain('!updateController.isRunning() && !harnessInstaller?.isRunning() && !turnActivity.hasActiveTurn()');
        expect(run).toContain('updateController.isRunning() || harnessInstaller?.isRunning() || turnActivity.hasActiveTurn()');
    });
});
