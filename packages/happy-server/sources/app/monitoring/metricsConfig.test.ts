import { describe, expect, it } from 'vitest';
import { resolveMetricsServerConfig } from './metricsConfig';

describe('metrics server configuration', () => {
    it('is disabled and loopback-bound by default', () => {
        expect(resolveMetricsServerConfig({})).toEqual({
            enabled: false,
            host: '127.0.0.1',
            port: 9090,
        });
    });

    it('requires an explicit true value to enable metrics', () => {
        expect(resolveMetricsServerConfig({ METRICS_ENABLED: 'true' }).enabled).toBe(true);
        expect(resolveMetricsServerConfig({ METRICS_ENABLED: 'false' }).enabled).toBe(false);
        expect(resolveMetricsServerConfig({ METRICS_ENABLED: '1' }).enabled).toBe(false);
    });

    it('supports an explicit host and valid port', () => {
        expect(resolveMetricsServerConfig({
            METRICS_ENABLED: 'true',
            METRICS_HOST: '0.0.0.0',
            METRICS_PORT: '9191',
        })).toEqual({ enabled: true, host: '0.0.0.0', port: 9191 });
    });

    it('falls back to the default port for invalid or unsafe values', () => {
        expect(resolveMetricsServerConfig({ METRICS_PORT: 'not-a-port' }).port).toBe(9090);
        expect(resolveMetricsServerConfig({ METRICS_PORT: '70000' }).port).toBe(9090);
        expect(resolveMetricsServerConfig({ METRICS_PORT: '0' }).port).toBe(9090);
    });
});
