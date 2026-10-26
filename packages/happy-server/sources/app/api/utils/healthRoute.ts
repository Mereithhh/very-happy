/**
 * B-827: liveness probes (the container healthcheck every 10 s, Caddy and the
 * release probe loop) must not write an info "incoming request" / "request
 * completed" pair per hit. On relay-us that was nearly the whole 5.6 GB
 * container log that filled a 20 GB disk. Warnings and errors on the route
 * still log.
 */
export const HEALTH_ROUTE_OPTIONS = { logLevel: 'warn' } as const;
