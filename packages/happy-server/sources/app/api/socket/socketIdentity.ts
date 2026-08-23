import { db } from '@/storage/db';

export type SocketClientType = 'session-scoped' | 'user-scoped' | 'machine-scoped';
const CLIENT_TYPES = new Set<SocketClientType>(['session-scoped', 'user-scoped', 'machine-scoped']);

export function parseSocketClientType(raw: unknown): SocketClientType | 'invalid' {
    if (raw === undefined) return 'user-scoped';
    return typeof raw === 'string' && CLIENT_TYPES.has(raw as SocketClientType) ? raw as SocketClientType : 'invalid';
}

export async function validateSocketOwnership(input: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string;
    machineId?: string;
}, client: Pick<typeof db, 'session' | 'machine'> = db): Promise<string | null> {
    if (input.clientType === 'session-scoped') {
        if (!input.sessionId) return 'Session ID required for session-scoped clients';
        const owned = await client.session.findFirst({ where: { id: input.sessionId, accountId: input.userId }, select: { id: true } });
        return owned ? null : 'Session not found';
    }
    if (input.clientType === 'machine-scoped') {
        if (!input.machineId) return 'Machine ID required for machine-scoped clients';
        const owned = await client.machine.findFirst({ where: { id: input.machineId, accountId: input.userId }, select: { id: true } });
        return owned ? null : 'Machine not found';
    }
    return null;
}
