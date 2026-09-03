/**
 * vitest runs happy-web-v2 in the **node** environment (there is no `test`
 * block in vite.config.ts), so `localStorage` and `window` do not exist.
 *
 * That only matters for tests that render real components, because the failure
 * happens at **import** time, not at call time, and the stack points somewhere
 * unhelpful:
 *
 *   - anything reaching `@/i18n/useTranslation` pulls in `@/text`, which calls
 *     `loadSettings()` → MMKV → `localStorage.getItem` while the module
 *     initialises, and then registers a `window.addEventListener` for the
 *     language-change event;
 *   - `getServerUrl()` and the onboarding commands read `window.location.origin`.
 *
 * So the stub has to be in place BEFORE the component module is imported —
 * static `import` is hoisted above every statement, which is why callers do:
 *
 *     let Thing: typeof import('./Thing').Thing;
 *     beforeAll(async () => {
 *         installBrowserTestGlobals();
 *         ({ Thing } = await import('./Thing'));
 *     });
 *
 * Pure-function modules need none of this — keep importing them normally.
 */

export interface BrowserTestGlobalsOptions {
    /** Value for `window.location.origin`; the self-hosted command builders read it. */
    origin?: string;
}

export function installBrowserTestGlobals(options: BrowserTestGlobalsOptions = {}): void {
    const globals = globalThis as Record<string, unknown>;
    const store = new Map<string, string>();

    globals.localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() { return store.size; },
    };

    globals.window = {
        location: { origin: options.origin ?? 'https://veryhappy.dev' },
        localStorage: globals.localStorage,
        // `@/text` subscribes at import time; a no-op is enough, nothing dispatches.
        addEventListener: () => {},
        removeEventListener: () => {},
        setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms),
        clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
        // Components read this synchronously during render (useMediaQuery,
        // prefers-reduced-motion); "no match" is the desktop-ish default.
        matchMedia: () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        }),
    };

    // Defining `window` flips code that branches on it into its browser path —
    // `shims/react-native.ts`'s AppState subscribes to `document`
    // 'visibilitychange' as soon as `@/sync/storage` is imported. So `document`
    // is not optional once `window` exists; leaving it out just moves the
    // ReferenceError one frame deeper.
    globals.document = {
        addEventListener: () => {},
        removeEventListener: () => {},
        visibilityState: 'visible',
        hasFocus: () => true,
        // `setDocumentLanguage` guards on `typeof document`, not on
        // `documentElement` — same lesson one level down.
        documentElement: { lang: 'en' },
    };
}
