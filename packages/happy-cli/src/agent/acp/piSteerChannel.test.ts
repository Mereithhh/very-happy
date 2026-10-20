import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { createPiSteerChannel } from './piSteerChannel';

describe('pi steer channel (B-632 ①)', () => {
  it('an offer is taken by a waiting poll and resolves on the ack', async () => {
    const channel = createPiSteerChannel();
    const taken = channel.take(1000);
    const offered = channel.offer('focus on tests', 1000);
    const item = await taken;
    expect(item).toEqual({ id: 1, text: 'focus on tests' });
    channel.ack(item!.id, true);
    await expect(offered).resolves.toBe(true);
  });

  it('nothing takes it in time → false (the caller queues it); taken but not acked → true (pi has it)', async () => {
    const channel = createPiSteerChannel();
    await expect(channel.offer('nobody polls', 20)).resolves.toBe(false);
    // The expired offer is gone: a later poll does not get a stale message.
    await expect(channel.take(20)).resolves.toBeNull();
    const taken = channel.take(1000);
    const offered = channel.offer('taken', 50);
    await taken;
    await expect(offered).resolves.toBe(true);
  });

  it('an ack with delivered:false (pi was no longer running) → false', async () => {
    const channel = createPiSteerChannel();
    const taken = channel.take(1000);
    const offered = channel.offer('late', 1000);
    channel.ack((await taken)!.id, false);
    await expect(offered).resolves.toBe(false);
  });

  it('a poll that went away does not swallow the next message', async () => {
    const channel = createPiSteerChannel();
    const gone = new AbortController();
    const poll = channel.take(1000, gone.signal);
    gone.abort();
    await expect(poll).resolves.toBeNull();
    const next = channel.take(1000);
    void channel.offer('for the live poll', 1000);
    await expect(next).resolves.toMatchObject({ text: 'for the live poll' });
  });

  it('end to end: the Very Happy pi extension takes a steer over the wrapper server and hands it to pi as deliverAs:steer', async () => {
    const channel = createPiSteerChannel();
    const client = { sessionId: 'steer-test', rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn() }, updateMetadata: vi.fn() } as unknown as ApiSessionClient;
    const server = await startHappyServer(client, { piSteer: channel });
    const before = { mcp: process.env.HAPPY_MCP_URL, steer: process.env.HAPPY_PI_STEER_URL };
    process.env.HAPPY_MCP_URL = server.url;
    process.env.HAPPY_PI_STEER_URL = server.steerUrl!;
    const handlers: Record<string, (...args: any[]) => any> = {};
    const steered: Array<{ text: string; options: unknown }> = [];
    try {
      // Cross-origin and unknown paths are refused.
      expect((await fetch(server.steerUrl!, { headers: { origin: 'https://evil.test' } })).status).toBe(403);
      expect((await fetch(server.url + 'runtime-steer/wrong', { method: 'POST' })).status).toBe(403);

      const factory = new Function('loadModule', PI_TEAMS_EXTENSION.replace('export default ', 'return ').replaceAll('import(', 'loadModule('))((specifier: string) => import(specifier));
      await factory({
        on: (name: string, handler: any) => { handlers[name] = handler; },
        registerTool: vi.fn(),
        sendUserMessage: (text: string, options: unknown) => { steered.push({ text, options }); },
      });
      expect(channel.ready).toBe(true); // the extension said hello

      await handlers.agent_start();
      await expect(channel.offer('focus on the failing test', 5000)).resolves.toBe(true);
      expect(steered).toEqual([{ text: 'focus on the failing test', options: { deliverAs: 'steer' } }]);
      await handlers.agent_end();
    } finally {
      if (before.mcp === undefined) delete process.env.HAPPY_MCP_URL; else process.env.HAPPY_MCP_URL = before.mcp;
      if (before.steer === undefined) delete process.env.HAPPY_PI_STEER_URL; else process.env.HAPPY_PI_STEER_URL = before.steer;
      server.stop();
    }
  });
});
