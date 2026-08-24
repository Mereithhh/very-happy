import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalHappyAgentCredentials } from './localHappyAgentAuth';

describe('local happy-agent credential relay binding', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function writeAgentKey(authServerUrl?: string): string {
    const home = mkdtempSync(join(tmpdir(), 'very-happy-agent-key-'));
    homes.push(home);
    writeFileSync(join(home, 'agent.key'), JSON.stringify({
      token: 'test-token',
      secret: Buffer.alloc(32, 7).toString('base64'),
      ...(authServerUrl ? { authServerUrl } : {}),
    }));
    return home;
  }

  it('accepts credentials explicitly issued by the same relay', () => {
    expect(readLocalHappyAgentCredentials(writeAgentKey('https://relay.example/path'), 'https://relay.example'))
      .not.toBeNull();
  });

  it('rejects foreign or issuer-less credentials for every relay', () => {
    expect(readLocalHappyAgentCredentials(writeAgentKey('https://other.example'), 'https://relay.example'))
      .toBeNull();
    expect(readLocalHappyAgentCredentials(writeAgentKey(), 'https://relay.example'))
      .toBeNull();
    expect(readLocalHappyAgentCredentials(writeAgentKey(), 'https://happy.mereith.com'))
      .toBeNull();
  });
});
