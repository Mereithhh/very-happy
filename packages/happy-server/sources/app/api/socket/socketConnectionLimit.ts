const DEFAULT_SOCKET_CONNECTIONS_PER_ACCOUNT = 128;

/**
 * Each running agent/session, browser and machine daemon owns a Socket.IO
 * connection. Long-lived accounts routinely exceed 20 connections, especially
 * after a server restart when every client reconnects together. Keep the cap
 * finite for public-relay abuse resistance without breaking that valid model.
 */
export function resolveSocketConnectionLimit(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.SOCKET_MAX_CONNECTIONS_PER_ACCOUNT;
    if (raw === undefined || raw.trim() === '') return DEFAULT_SOCKET_CONNECTIONS_PER_ACCOUNT;

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_SOCKET_CONNECTIONS_PER_ACCOUNT;
}
