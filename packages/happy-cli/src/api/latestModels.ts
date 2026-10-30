import { parseLatestModelTable, type LatestModelTable } from '@slopus/happy-wire'

/**
 * B-844: the server's "follow latest" table (`GET /v1/models/latest`).
 * Best effort with a short timeout: null = use the table bundled in
 * happy-wire, so an old or unreachable server never blocks a spawn.
 */
export async function fetchLatestModelTable(
    serverUrl: string,
    fetcher: typeof fetch = fetch,
    timeoutMs = 2_000,
): Promise<LatestModelTable | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetcher(`${serverUrl}/v1/models/latest`, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
        })
        if (!response.ok) return null
        const body = await response.json() as { table?: unknown }
        return parseLatestModelTable(body?.table)
    } catch {
        return null
    } finally {
        clearTimeout(timeout)
    }
}
