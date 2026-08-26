import { Redis } from 'ioredis';

let coordinationClient: Redis | null = null;
let coordinationUrl: string | null = null;

export async function initializeCoordinationRedis(url: string): Promise<Redis> {
    if (coordinationClient) {
        if (coordinationUrl !== url) throw new Error('Coordination Redis is already initialized with another URL');
        return coordinationClient;
    }

    const client = new Redis(url, {
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: 2,
    });
    try {
        await client.connect();
        const pong = await client.ping();
        if (pong !== 'PONG') throw new Error(`Unexpected Redis PING response: ${pong}`);
    } catch (error) {
        client.disconnect();
        throw error;
    }
    coordinationClient = client;
    coordinationUrl = url;
    return client;
}
export function getCoordinationRedis(): Redis | null {
    return coordinationClient;
}

export async function closeCoordinationRedis(): Promise<void> {
    const client = coordinationClient;
    coordinationClient = null;
    coordinationUrl = null;
    if (!client) return;
    try {
        await client.quit();
    } catch {
        client.disconnect();
    }
}
