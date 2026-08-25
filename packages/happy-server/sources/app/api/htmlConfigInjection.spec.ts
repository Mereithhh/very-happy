import { describe, expect, it } from 'vitest';
import { injectRuntimeConfig, runtimeConfigScript } from './htmlConfigInjection';

describe('runtime HTML config injection', () => {
    it('serializes the config into a stable marked script', () => {
        expect(runtimeConfigScript({ serverUrl: 'same-origin' })).toBe(
            '<script id="vh-runtime-config">window.__HAPPY_CONFIG__ = {"serverUrl":"same-origin"};</script>',
        );
    });

    it('is idempotent when SPA fallback output passes through onSend', () => {
        const script = runtimeConfigScript({ serverUrl: 'https://relay.example' });
        const once = injectRuntimeConfig('<html><head></head><body></body></html>', script);
        const twice = injectRuntimeConfig(once, script);
        expect(twice).toBe(once);
        expect(twice.match(/__HAPPY_CONFIG__/g)).toHaveLength(1);
    });
});
