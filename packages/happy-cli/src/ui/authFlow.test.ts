import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import { openBrowser } from '@/utils/browser';
import { doAuth } from './auth';
import { credentialRelayProblem } from './authRelay';

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

vi.mock('@/utils/browser', () => ({
  openBrowser: vi.fn(),
}));

const authFlow = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
const authCommand = readFileSync(new URL('../commands/auth.ts', import.meta.url), 'utf8');
const cliPackage = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');

describe('Web-only CLI authentication flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(axios.post).mockReset();
    vi.mocked(openBrowser).mockReset();
  });

  it('opens Web approval directly and keeps the claim secret out of the URL', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { protocolVersion: 3, claimSecretRequired: true, state: 'pending' } })
      .mockRejectedValueOnce(new Error('stop after first poll'));
    vi.mocked(openBrowser).mockResolvedValue(false);
    const logs: string[] = [];
    vi.spyOn(console, 'clear').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logs.push(args.join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(doAuth()).resolves.toBeNull();

    expect(axios.post).toHaveBeenCalledTimes(2);
    const createBody = vi.mocked(axios.post).mock.calls[0]?.[1] as Record<string, unknown>;
    const pollBody = vi.mocked(axios.post).mock.calls[1]?.[1] as Record<string, unknown>;
    expect(createBody).toMatchObject({ supportsV2: true, supportsClaimSecret: true, pairingAction: 'create' });
    expect(pollBody).toMatchObject({ supportsV2: true, supportsClaimSecret: true, pairingAction: 'poll' });
    expect(pollBody.claimSecret).toBe(createBody.claimSecret);

    expect(openBrowser).toHaveBeenCalledOnce();
    const approvalUrl = vi.mocked(openBrowser).mock.calls[0]?.[0] as string;
    expect(approvalUrl).toContain('/terminal/connect#key=');
    expect(approvalUrl).not.toContain(String(createBody.claimSecret));
    expect(approvalUrl).not.toContain('happy://');
    expect(logs.join('\n')).toContain('Web Authentication');
    expect(logs.join('\n')).not.toMatch(/mobile app|scan.*qr|authentication method/i);
  });

  it('fails closed before opening the browser when secure pairing v3 is unavailable', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { protocolVersion: 2 } });
    vi.spyOn(console, 'clear').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(doAuth()).resolves.toBeNull();

    expect(openBrowser).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it('removes the native app selector and QR dependency from the shipped source', () => {
    expect(authFlow).toContain('return await doWebAuth(keypair, claimSecret)');
    expect(authFlow).not.toContain('selectAuthenticationMethod');
    expect(authFlow).not.toContain('doMobileAuth');
    expect(authFlow).not.toContain('happy://terminal?');
    expect(authFlow).not.toContain('Happy mobile app');
    expect(cliPackage).not.toContain('qrcode-terminal');
  });

  it('prints daemon startup as the next required step after pairing', () => {
    expect(authCommand).toContain('function printDaemonNextStep()');
    expect(authCommand.match(/printDaemonNextStep\(\);/g)).toHaveLength(2);
    expect(authCommand).toContain('Next: start the machine daemon');
    expect(authCommand).toContain("chalk.cyan('very-happy daemon start')");
    expect(authCommand).toContain('Keep the same HAPPY_SERVER_URL and HAPPY_WEBAPP_URL environment');
    expect(authCommand).toContain('It starts in the background and keeps this machine available in Web.');
  });

  it('refuses to silently reuse credentials issued by another or unknown relay', () => {
    expect(credentialRelayProblem('https://veryhappy.dev', 'https://relay.example.com')).toContain('Credentials belong to');
    expect(credentialRelayProblem(undefined, 'https://relay.example.com')).toContain('predate relay tracking');
    expect(credentialRelayProblem('https://relay.example.com/', 'https://relay.example.com')).toBeUndefined();
    expect(credentialRelayProblem(undefined, 'https://veryhappy.dev')).toBeUndefined();
    expect(authFlow).toContain('credentialRelayProblem(credentials.authServerUrl, configuration.serverUrl)');
    expect(authFlow.indexOf('credentialRelayProblem(credentials.authServerUrl')).toBeLessThan(
      authFlow.indexOf("logger.debug('[AUTH] Using existing credentials')"),
    );
  });
});
