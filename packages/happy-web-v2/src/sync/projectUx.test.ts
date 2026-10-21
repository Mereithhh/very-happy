import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'http://srv' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'web/test' }));

const load = () => import('./projectUx');

describe('project UX telemetry (B-651)', () => {
  afterEach(async () => { (await load())._forTests.reset(); });

  it('batches events and sends counts only', async () => {
    const m = await load();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    m.reportProjectUx({ kind: 'dispatch', entry: 'project', inProject: true });
    m.reportProjectUx({ kind: 'attention_open', latencyMs: 1200, inProject: false });
    await m.flushProjectUx(fetchImpl as any);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://srv/v1/projects/ux-events');
    expect(JSON.parse(String(init.body))).toEqual({ events: [{ kind: 'dispatch', entry: 'project', inProject: true }, { kind: 'attention_open', latencyMs: 1200, inProject: false }] });
  });
  it('an older server (404) switches reporting off; failures never throw', async () => {
    const m = await load();
    m.reportProjectUx({ kind: 'dispatch', entry: 'quick', inProject: false });
    await m.flushProjectUx((async () => new Response('', { status: 404 })) as any);
    expect(m._forTests.disabled()).toBe(true);
    m.reportProjectUx({ kind: 'dispatch', entry: 'quick', inProject: false });
    expect(m._forTests.queue()).toEqual([]);
    m._forTests.reset();
    m.reportProjectUx({ kind: 'dispatch', entry: 'quick', inProject: false });
    await expect(m.flushProjectUx((async () => { throw new Error('offline'); }) as any)).resolves.toBeUndefined();
  });
  it('reports each waiting episode once, ignores missing/future stamps', async () => {
    const m = await load();
    expect(m.reportAttentionOpen('s1', 1_000, true, 61_000)).toBe(true);
    expect(m.reportAttentionOpen('s1', 1_000, true, 99_000)).toBe(false);
    expect(m.reportAttentionOpen('s1', 70_000, true, 99_000)).toBe(true);
    expect(m.reportAttentionOpen('s2', undefined, true)).toBe(false);
    expect(m.reportAttentionOpen('s3', 5_000, true, 1_000)).toBe(false);
    expect(m._forTests.queue()).toEqual([{ kind: 'attention_open', latencyMs: 60_000, inProject: true }, { kind: 'attention_open', latencyMs: 29_000, inProject: true }]);
  });
  it('maps pending-session sources to entry points', async () => {
    const m = await load();
    expect(m.dispatchEntryOf('dialog')).toBe('dialog');
    expect(m.dispatchEntryOf('fork')).toBe('other');
  });
});
