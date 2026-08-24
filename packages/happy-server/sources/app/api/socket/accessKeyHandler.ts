import { Socket } from "socket.io";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { accessKeyIdSchema } from '@/app/accessKeys/accessKeyStore';
import { AccountTerminalRateLimiter, allowAccountRelay } from './terminalRateLimit';

export function accessKeyHandler(userId: string, socket: Socket, rateLimiter?: AccountTerminalRateLimiter) {
    // Get access key via socket
    socket.on('access-key-get', async (data: { sessionId: string; machineId: string }, callback: (response: any) => void) => {
        if (!allowAccountRelay({
            limiter: rateLimiter,
            accountId: userId,
            socket,
            resource: 'access-key-read',
            payload: data,
        })) return;
        try {
            const parsed = accessKeyIdSchema.safeParse(data?.sessionId);
            const parsedMachine = accessKeyIdSchema.safeParse(data?.machineId);
            if (!parsed.success || !parsedMachine.success) {
                callback?.({
                    ok: false,
                    error: 'Invalid parameters: sessionId and machineId are required'
                });
                return;
            }
            const sessionId = parsed.data;
            const machineId = parsedMachine.data;

            // Verify session and machine belong to user
            const [session, machine] = await Promise.all([
                db.session.findFirst({
                    where: { id: sessionId, accountId: userId }
                }),
                db.machine.findFirst({
                    where: { id: machineId, accountId: userId }
                })
            ]);

            if (!session || !machine) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Session or machine not found'
                    });
                }
                return;
            }

            // Get access key
            const accessKey = await db.accessKey.findUnique({
                where: {
                    accountId_machineId_sessionId: {
                        accountId: userId,
                        machineId,
                        sessionId
                    }
                }
            });

            if (callback) {
                if (accessKey) {
                    callback({
                        ok: true,
                        accessKey: {
                            data: accessKey.data,
                            dataVersion: accessKey.dataVersion,
                            createdAt: accessKey.createdAt.getTime(),
                            updatedAt: accessKey.updatedAt.getTime()
                        }
                    });
                } else {
                    callback({
                        ok: true,
                        accessKey: null
                    });
                }
            }

            log({ module: 'websocket-access-key', sessionId, machineId }, 'Access key retrieved');
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in access-key-get');
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });
}
