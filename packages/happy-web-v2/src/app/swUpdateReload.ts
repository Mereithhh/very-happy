/**
 * B-823: a new service worker taking over an already-controlled page reloads
 * it onto the new shell — ourselves, not through workbox-window's bookkeeping.
 *
 * `registerType: 'autoUpdate'` reloads on workbox-window's `activated` event,
 * which it only emits for a worker it saw arrive (`updatefound` after its own
 * `register()` resolved). Chrome can find the update first: `register()` queues
 * behind the navigation's deferred update check, which runs ~3s after the
 * worker's last event, so a page that keeps its worker busy at boot (the B-823
 * startup preloads) had `register()` resolve only after the new worker was
 * already installed. Workbox never tracked it, the new worker took control,
 * and the page stayed on the old shell (harness: 6/6 opens after a release;
 * the base build 0/6) until the stale-bundle prompt offered the update.
 *
 * `controllerchange` does not depend on who found the update. A page that had
 * no controller at boot (first visit: `clients.claim()` adopts it) is not an
 * update and never reloads.
 */
export interface SwUpdateReloadDeps {
  container: Pick<ServiceWorkerContainer, 'addEventListener'> | undefined;
  /** `navigator.serviceWorker.controller` when the page started. */
  controlledAtBoot: boolean;
  /** Flush drafts, leave the 「已更新」 receipt, stand the unload guard down. */
  beforeReload: () => void;
  reload: () => void;
}

export function installSwUpdateReload(deps: SwUpdateReloadDeps): void {
  let reloading = false;
  deps.container?.addEventListener('controllerchange', () => {
    if (!deps.controlledAtBoot || reloading) return;
    reloading = true;
    deps.beforeReload();
    deps.reload();
  });
}
