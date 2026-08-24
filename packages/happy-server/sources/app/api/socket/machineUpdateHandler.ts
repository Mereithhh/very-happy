import { getMetricsLabelsFromSocket, machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { isAccountResourceLimitError } from '../resourceLimits';
import { updateMachineStateWithQuota } from '@/app/state/accountStateStore';

export function machineUpdateHandler(userId: string, socket: Socket) {
    const labels = getMetricsLabelsFromSocket(socket);

    socket.on('machine-alive', async (data: {
        machineId: string;
        time: number;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive', ...labels });
            machineAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.machineId) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(data.machineId, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueMachineUpdate(data.machineId, t);

            const machineActivity = buildMachineActivityEphemeral(data.machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in machine-alive');
        }
    });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const result = await updateMachineStateWithQuota({
                accountId: userId,
                machineId: data?.machineId,
                field: 'metadata',
                value: data?.metadata,
                expectedVersion: data?.expectedVersion,
            });
            if (result.kind === 'not-found') {
                callback?.({ result: 'error', message: 'Machine not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback?.({
                    result: 'version-mismatch',
                    version: result.machine.metadataVersion,
                    metadata: result.machine.metadata,
                });
                return;
            }

            // Generate machine metadata update
            const metadataUpdate = {
                value: result.machine.metadata,
                version: result.machine.metadataVersion,
            };
            const updatePayload = buildUpdateMachineUpdate(result.machine.id, result.updateSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId: result.machine.id }
            });

            callback?.({
                result: 'success',
                version: result.machine.metadataVersion,
                metadata: result.machine.metadata,
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', error: error.code, message: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in machine-update-metadata');
            callback?.({ result: 'error', message: 'Internal error' });
        }
    });

    // Machine daemon state update with optimistic concurrency control
    socket.on('machine-update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const result = await updateMachineStateWithQuota({
                accountId: userId,
                machineId: data?.machineId,
                field: 'daemonState',
                value: data?.daemonState,
                expectedVersion: data?.expectedVersion,
            });
            if (result.kind === 'not-found') {
                callback?.({ result: 'error', message: 'Machine not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                callback?.({
                    result: 'version-mismatch',
                    version: result.machine.daemonStateVersion,
                    daemonState: result.machine.daemonState,
                });
                return;
            }

            // Generate machine daemon state update
            const daemonStateUpdate = {
                value: result.machine.daemonState!,
                version: result.machine.daemonStateVersion,
            };
            const updatePayload = buildUpdateMachineUpdate(result.machine.id, result.updateSeq, randomKeyNaked(12), undefined, daemonStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId: result.machine.id }
            });

            callback?.({
                result: 'success',
                version: result.machine.daemonStateVersion,
                daemonState: result.machine.daemonState,
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', error: error.code, message: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in machine-update-state');
            callback?.({ result: 'error', message: 'Internal error' });
        }
    });
}
