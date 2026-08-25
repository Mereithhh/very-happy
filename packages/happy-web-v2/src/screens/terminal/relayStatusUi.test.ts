import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('terminal relay status UI', () => {
  it('shows relay region and measured RTT while retaining explicit fallback', () => {
    const screen = readFileSync(new URL('./WebTerminalScreen.tsx', import.meta.url), 'utf8');
    const socket = readFileSync(new URL('../../sync/apiSocket.ts', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./terminal.css', import.meta.url), 'utf8');
    expect(screen).toContain('apiSocket.onMachineRelayStatus');
    expect(screen).toContain('browser RTT');
    expect(screen).toContain('formatRelayRegion(relayStatus.region)');
    expect(screen).not.toContain('`${relayStatus.relayId}');
    expect(screen).toContain("'CONTROL'");
    expect(socket).toContain("transport: 'regional'");
    expect(socket).toContain("transport: 'legacy'");
    expect(styles).toContain('.term-relay.is-connected');
    expect(styles).not.toMatch(/\.term-relay[\s\S]{0,500}#[0-9a-f]{3,8}\b/i);
  });
});
