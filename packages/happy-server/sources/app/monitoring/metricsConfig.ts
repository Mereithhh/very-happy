export type MetricsServerConfig = {
    enabled: boolean;
    host: string;
    port: number;
};

/**
 * Metrics are opt-in and loopback-only unless the operator explicitly chooses
 * another bind address. This keeps a clean checkout from publishing database
 * and process telemetry on every interface.
 */
export function resolveMetricsServerConfig(
    env: Record<string, string | undefined> = process.env,
): MetricsServerConfig {
    const parsedPort = env.METRICS_PORT ? Number(env.METRICS_PORT) : 9090;
    const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
        ? parsedPort
        : 9090;
    return {
        enabled: env.METRICS_ENABLED === 'true',
        host: env.METRICS_HOST?.trim() || '127.0.0.1',
        port,
    };
}
