/**
 * B-632 ①: steering a running pi turn. pi 1.x has the hook
 * (`pi.sendUserMessage(text, { deliverAs: 'steer' })`, extension API) but
 * pi-acp only queues a prompt sent mid-turn behind it. The Very Happy pi
 * extension (teams/resources.ts) long-polls this channel over the wrapper's
 * local HTTP server while pi is running and hands each message to pi as a
 * steer, then acknowledges it.
 *
 * Contract: `offer()` resolves true only when the extension took the message
 * (an ack, or a take that was not acked before the deadline — pi already has
 * it, re-queuing would deliver it twice); false when nothing took it in time,
 * so the caller queues it as the next turn exactly as before. The wrapper
 * advertises `pi-steer-v1` only after the extension said hello (rule 14:
 * a capability is what is in effect, not what was intended).
 */
export type PiSteerItem = { id: number; text: string };

export function createPiSteerChannel() {
  let nextId = 0;
  const pending: PiSteerItem[] = [];
  const waiters = new Set<(item: PiSteerItem | null) => void>();
  const offers = new Map<number, { taken: boolean; settle: (delivered: boolean) => void }>();
  let ready = false;
  const readyListeners: Array<() => void> = [];

  const hand = (): void => {
    while (pending.length > 0 && waiters.size > 0) {
      const waiter = waiters.values().next().value!;
      waiters.delete(waiter);
      const item = pending.shift()!;
      const offer = offers.get(item.id);
      if (offer) offer.taken = true;
      waiter(item);
    }
  };

  return {
    get ready() { return ready; },
    /** The extension announced itself (first contact). */
    hello(): void {
      if (ready) return;
      ready = true;
      for (const listener of readyListeners.splice(0)) listener();
    },
    onReady(listener: () => void): void {
      if (ready) listener(); else readyListeners.push(listener);
    },
    /** Wrapper side: hand `text` to the running turn; true = pi took it. */
    offer(text: string, timeoutMs: number): Promise<boolean> {
      const item: PiSteerItem = { id: ++nextId, text };
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const offer = offers.get(item.id);
          offers.delete(item.id);
          const index = pending.findIndex((p) => p.id === item.id);
          if (index >= 0) pending.splice(index, 1);
          resolve(offer?.taken === true);
        }, timeoutMs);
        timer.unref?.();
        offers.set(item.id, {
          taken: false,
          settle: (delivered) => { clearTimeout(timer); offers.delete(item.id); resolve(delivered); },
        });
        pending.push(item);
        hand();
      });
    },
    /** Extension side (long poll): the next message, or null after `waitMs`. */
    take(waitMs: number, signal?: AbortSignal): Promise<PiSteerItem | null> {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        const waiter = (item: PiSteerItem | null) => { done(); resolve(item); };
        // A poll whose connection went away must not swallow the next message.
        const onAbort = () => { waiters.delete(waiter); done(); resolve(null); };
        const timer = setTimeout(() => { waiters.delete(waiter); done(); resolve(null); }, waitMs);
        timer.unref?.();
        if (signal?.aborted) { resolve(null); clearTimeout(timer); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.add(waiter);
        hand();
      });
    },
    /** Extension side: what happened to a taken message (false: pi was no longer running). */
    ack(id: number, delivered: boolean): void {
      offers.get(id)?.settle(delivered);
    },
  };
}

export type PiSteerChannel = ReturnType<typeof createPiSteerChannel>;
