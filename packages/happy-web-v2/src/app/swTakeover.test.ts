import { describe, expect, it } from 'vitest';
import {
  type CacheLike,
  type CacheStorageLike,
  type ContainerLike,
  type RegistrationLike,
  dropPrecachedShell,
  takeNewServiceWorker,
} from './swTakeover';

/**
 * B-356 regression cover. The incident: `applyUpdate` reloaded the moment
 * `registration.update()` resolved, the outgoing worker answered the navigation
 * from its own precache, and the page came back on the SAME shell — no new
 * changelog, and the reload guard then hid the update for ten minutes.
 */

type Listener = () => void;

class FakeRegistration implements RegistrationLike {
  installing: unknown = null;
  waiting: unknown = null;
  private readonly listeners = new Set<Listener>();
  updateCalls = 0;

  constructor(private readonly onUpdate: (registration: FakeRegistration) => Promise<void> | void = () => {}) {}

  async update(): Promise<void> {
    this.updateCalls += 1;
    await this.onUpdate(this);
  }

  addEventListener(_type: 'updatefound', listener: Listener): void { this.listeners.add(listener); }
  removeEventListener(_type: 'updatefound', listener: Listener): void { this.listeners.delete(listener); }
  emitUpdateFound(): void { for (const listener of [...this.listeners]) listener(); }
}

class FakeContainer implements ContainerLike {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly registrations: readonly FakeRegistration[] | Error) {}

  async getRegistrations(): Promise<readonly RegistrationLike[]> {
    if (this.registrations instanceof Error) throw this.registrations;
    return this.registrations;
  }

  addEventListener(_type: 'controllerchange', listener: Listener): void { this.listeners.add(listener); }
  removeEventListener(_type: 'controllerchange', listener: Listener): void { this.listeners.delete(listener); }
  takeControl(): void { for (const listener of [...this.listeners]) listener(); }
  get listenerCount(): number { return this.listeners.size; }
}

describe('takeNewServiceWorker', () => {
  it('waits for the new worker to control the page before reporting success', async () => {
    let container!: FakeContainer;
    const registration = new FakeRegistration((r) => {
      // update() resolves when the worker has INSTALLED; claiming comes later.
      r.installing = {};
    });
    container = new FakeContainer([registration]);

    const outcome = takeNewServiceWorker(container, 1_000);
    // Nothing has claimed the page yet, so the update must not be reported done.
    await Promise.resolve();
    setTimeout(() => { registration.installing = null; container.takeControl(); }, 5);
    await expect(outcome).resolves.toBe('controlled');
    expect(registration.updateCalls).toBe(1);
  });

  it('does not miss a handover that completes while update() is still settling', async () => {
    // skipWaiting + clientsClaim can fire controllerchange before update()
    // resolves. Subscribing after the await would wait out the whole budget.
    let container!: FakeContainer;
    const registration = new FakeRegistration((r) => {
      r.installing = {};
      container.takeControl();
      r.installing = null;
    });
    container = new FakeContainer([registration]);

    await expect(takeNewServiceWorker(container, 1_000)).resolves.toBe('controlled');
  });

  it('counts a worker announced only by updatefound', async () => {
    let container!: FakeContainer;
    const registration = new FakeRegistration((r) => {
      r.emitUpdateFound(); // installed and activated before update() resolved
    });
    container = new FakeContainer([registration]);

    const outcome = takeNewServiceWorker(container, 1_000);
    setTimeout(() => container.takeControl(), 5);
    await expect(outcome).resolves.toBe('controlled');
  });

  it('reports already-current when no new worker arrives', async () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer([registration]);
    await expect(takeNewServiceWorker(container, 1_000)).resolves.toBe('already-current');
  });

  it('gives up within the budget so the reload is never gated', async () => {
    const registration = new FakeRegistration((r) => { r.waiting = {}; });
    const container = new FakeContainer([registration]);
    const started = Date.now();
    await expect(takeNewServiceWorker(container, 20)).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('unsubscribes on every path, so repeated updates do not leak listeners', async () => {
    const registration = new FakeRegistration();
    const container = new FakeContainer([registration]);
    await takeNewServiceWorker(container, 20);
    await takeNewServiceWorker(container, 20);
    expect(container.listenerCount).toBe(0);
  });

  it('reports no-worker when service workers are unavailable or blocked', async () => {
    await expect(takeNewServiceWorker(undefined, 20)).resolves.toBe('no-worker');
    await expect(takeNewServiceWorker(new FakeContainer([]), 20)).resolves.toBe('no-worker');
    await expect(takeNewServiceWorker(new FakeContainer(new Error('blocked')), 20)).resolves.toBe('no-worker');
  });

  it('never rejects when a registration update throws', async () => {
    const registration = new FakeRegistration(() => { throw new Error('offline'); });
    const container = new FakeContainer([registration]);
    await expect(takeNewServiceWorker(container, 20)).resolves.toBe('already-current');
  });
});

class FakeCache implements CacheLike {
  constructor(public urls: string[]) {}
  async keys(): Promise<readonly { url: string }[]> { return this.urls.map((url) => ({ url })); }
  async delete(request: { url: string }): Promise<boolean> {
    const before = this.urls.length;
    this.urls = this.urls.filter((url) => url !== request.url);
    return this.urls.length < before;
  }
}

describe('dropPrecachedShell', () => {
  const shell = 'https://veryhappy.dev/index.html?__WB_REVISION__=abc123';
  const asset = 'https://veryhappy.dev/assets/index-abc.js';

  it('drops only the precached shell, from precache caches only', async () => {
    const precache = new FakeCache([shell, asset, 'https://veryhappy.dev/manifest.webmanifest']);
    const runtime = new FakeCache([shell]);
    const storage: CacheStorageLike = {
      keys: async () => ['workbox-precache-v2-https://veryhappy.dev/', 'very-happy-assets-v1'],
      open: async (name) => (name.startsWith('workbox-precache') ? precache : runtime),
    };

    await expect(dropPrecachedShell(storage)).resolves.toBe(1);
    expect(precache.urls).toEqual([asset, 'https://veryhappy.dev/manifest.webmanifest']);
    expect(runtime.urls).toEqual([shell]); // runtime asset cache is left alone
  });

  it('is a no-op without a CacheStorage and never throws when it is blocked', async () => {
    await expect(dropPrecachedShell(undefined)).resolves.toBe(0);
    await expect(dropPrecachedShell({
      keys: async () => { throw new Error('blocked'); },
      open: async () => new FakeCache([]),
    })).resolves.toBe(0);
  });
});
