import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const syncSource = readFileSync(new URL('./terminalSync.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app/AppRoot.tsx', import.meta.url), 'utf8');

describe('terminal push hydration before first workspace paint', () => {
  it('feeds restored machine snapshots in a layout effect', () => {
    expect(syncSource).toContain("import { useLayoutEffect } from 'react'");
    expect(syncSource).toMatch(/export function useTerminalSync\(\): void \{\s*\/\/[\s\S]*?useLayoutEffect\(\(\) => \{/);
    expect(syncSource).not.toContain("import { useEffect } from 'react'");
  });

  it('keeps the real empty-workspace guide after all data is ready', () => {
    expect(appSource).toContain("terminalCount === 0) return <HelpScreen />");
    expect(appSource).toContain('if (!dataReady)');
  });
});

describe('B-360 the ownership tiebreaker reaches the store', () => {
  it('applyPush is given the snapshot\'s updatedAt, not just its terminals', () => {
    // Two machine rows can hold the SAME host (a rotated machine id), and then
    // both push the same tmux ids. terminalPushOps decides which row owns an id
    // by comparing snapshot recency — so dropping this argument here silently
    // restores the duplicate while every pure test stays green.
    expect(syncSource).toContain('applyPush(id, machineLabel(machine), snapshot.terminals, snapshot.updatedAt)');
  });
});
