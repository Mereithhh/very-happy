# Lazy chunk recovery during Web updates

Status: Shipped — PR #350, 4d267c4dde33d8e6d68835414998b46ca7ca1046, 2026-09-10.

Reported: navigation after a frontend update fails with `Failed to fetch dynamically imported module`, exposing React Router's default error page. The reported retired JS URL was verified to return HTTP 200 `text/html`.

## Mechanism

- Missing static assets must return non-cacheable 404, never the SPA shell. Existing application routes still receive HTML; APIs and non-GET requests do not.
- Vite preload failure flushes mounted drafts immediately and starts the same worker handover used by normal updates. It must not call naked `location.reload()` or suppress the import error (suppression resolves the import as undefined).
- Read the current network shell with a bounded request. If unavailable, display retry UI without automatic reload. Otherwise use `applyUpdate`: bounded worker takeover, draft flush, then reload at the current URL.
- Concurrent failures share recovery. Persist the attempted target entry per tab before applying it. The same target cannot auto-reload repeatedly, including after another document starts; a later target or explicit retry is allowed. Block automatic reload when persistent storage is unavailable.
- Both router roots and entry-level root imports have a built-in fallback, without needing another lazy download. Ordinary application errors do not trigger automatic update recovery.

No protocol or storage migration. New server behavior is compatible with old clients; full recovery requires a client containing this fix. Server/Web ship as the same immutable image. Existing pre-fix pages may need a manual refresh once.

## Verification

Unit tests cover concurrent failures, persistent guards, unavailable storage/network, manual retry and later targets. Server injection tests cover missing assets/API vs SPA routes. Two production builds and Chromium must verify the old loaded entry, failed lazy request, worker controller change, new loaded entry and bounded failure behavior. Do not infer success from `registration.update()` alone.

Local verification (2026-09-10): two salted production builds confirmed a retired lazy chunk request, `controllerchange` count 1 → 2, loaded entry `chunkbefore` → `chunkafter`, and preserved `/signup` route. A continuously missing root chunk produced exactly one automatic reload followed by retry UI. Full Web regression passed 2,785 cases and server passed 649 (one existing Redis integration skip) at bounded worker concurrency; the first concurrent run hit timing/database initialization limits and was not counted as passing.

Final-build browser verification also confirmed no reload while offline, successful explicit retry after reconnecting, and overflow-free retry UI at 320/390px with coarse input in both themes. The listener regression additionally verifies draft flush ordering and that the original import rejection is not suppressed. Artifacts: `~/code/github/skills/tmp/vh-chunk-recovery/` (two builds, browser harness, controller/entry evidence, screenshots and test logs).


## Release verification
- Production deployment 34491423420 succeeded for the full immutable Web/Server image; rollback release c7db3fc2.
- Production login loaded the 4d267c4d entry without page errors. The originally reported retired WebTerminalRoute URL returned HTTP 404, application/json, cache-control no-store.
- Local gates: Web 2,794, CLI 2,134, wire 82 and Server 649 passing tests (one existing Server skip); builds, types and CLI built-artifact version check passed. PR and exact main SHA quality workflows succeeded.
- Existing pre-fix documents may still need one manual refresh to obtain the recovery code. No CLI release or database migration.
