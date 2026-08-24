import { Socket } from "socket.io";
import { AsyncLock } from "@/utils/lock";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { isAccountResourceLimitError } from '../resourceLimits';
import { saveUsageReport, usageReportSchema } from '@/app/usage/usageStore';

export function usageHandler(userId: string, socket: Socket) {
    const receiveUsageLock = new AsyncLock();
    socket.on('usage-report', async (data: any, callback?: (response: any) => void) => {
        await receiveUsageLock.inLock(async () => {
            try {
                const parsed = usageReportSchema.safeParse(data);
                if (!parsed.success) {
                    callback?.({ success: false, error: 'invalid_usage_report' });
                    return;
                }
                const { key, sessionId, tokens, cost } = parsed.data;

                try {
                    const result = await saveUsageReport(userId, parsed.data);
                    if (result.kind === 'session-not-found') {
                        callback?.({ success: false, error: 'Session not found' });
                        return;
                    }
                    const { report } = result;
                    const usageData: PrismaJson.UsageReportData = { tokens, cost };

                    log({ module: 'websocket', userId, sessionId, key }, 'Usage report saved');

                    // Emit usage ephemeral update if sessionId is provided
                    if (sessionId) {
                        const usageEvent = buildUsageEphemeral(sessionId, key, usageData.tokens, usageData.cost);
                        eventRouter.emitEphemeral({
                            userId,
                            payload: usageEvent,
                            recipientFilter: { type: 'user-scoped-only' }
                        });
                    }

                    if (callback) {
                        callback({
                            success: true,
                            reportId: report.id,
                            createdAt: report.createdAt.getTime(),
                            updatedAt: report.updatedAt.getTime()
                        });
                    }
                } catch (error) {
                    if (isAccountResourceLimitError(error)) {
                        callback?.({ success: false, error: error.code });
                        return;
                    }
                    log({ module: 'websocket', level: 'error', error }, 'Failed to save usage report');
                    if (callback) {
                        callback({ success: false, error: 'Failed to save usage report' });
                    }
                }
            } catch (error) {
                log({ module: 'websocket', level: 'error', error }, 'Error in usage-report handler');
                if (callback) {
                    callback({ success: false, error: 'Internal error' });
                }
            }
        });
    });
}
