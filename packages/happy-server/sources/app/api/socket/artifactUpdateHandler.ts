import { getMetricsLabelsFromSocket, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";
import {
    artifactCreateSchema,
    artifactIdSchema,
    artifactUpdateSchema,
    createArtifactWithQuota,
    updateArtifactWithQuota,
} from '@/app/artifacts/artifactStore';
import { isAccountResourceLimitError } from '../resourceLimits';

export function artifactUpdateHandler(userId: string, socket: Socket) {
    const labels = getMetricsLabelsFromSocket(socket);
    // Read artifact with full body
    socket.on('artifact-read', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-read', ...labels });

            const idResult = artifactIdSchema.safeParse(data?.artifactId);
            if (!idResult.success) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const artifactId = idResult.data;

            // Fetch artifact
            const artifact = await db.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: userId
                }
            });

            if (!artifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Return artifact data
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in artifact-read');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Update artifact with optimistic concurrency control
    socket.on('artifact-update', async (data: {
        artifactId: string;
        header?: {
            data: string;
            expectedVersion: number;
        };
        body?: {
            data: string;
            expectedVersion: number;
        };
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-update', ...labels });

            const { artifactId, header, body } = data ?? {};
            const idResult = artifactIdSchema.safeParse(artifactId);
            const updateResult = artifactUpdateSchema.safeParse({
                header: header?.data,
                expectedHeaderVersion: header?.expectedVersion,
                body: body?.data,
                expectedBodyVersion: body?.expectedVersion,
            });
            if (!idResult.success || !updateResult.success) {
                callback?.({ result: 'error', message: 'Invalid parameters' });
                return;
            }

            const result = await updateArtifactWithQuota(userId, idResult.data, updateResult.data);
            if (result.kind === 'not-found') {
                callback?.({ result: 'error', message: 'Artifact not found' });
                return;
            }
            if (result.kind === 'version-mismatch') {
                const response: any = { result: 'version-mismatch' };
                if (result.headerMismatch) {
                    response.header = {
                        currentVersion: result.artifact.headerVersion,
                        currentData: privacyKit.encodeBase64(result.artifact.header),
                    };
                }
                if (result.bodyMismatch) {
                    response.body = {
                        currentVersion: result.artifact.bodyVersion,
                        currentData: privacyKit.encodeBase64(result.artifact.body),
                    };
                }
                callback(response);
                return;
            }
            const { headerUpdate, bodyUpdate } = result;

            // Emit update event
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateArtifactUpdate(artifactId, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Send success response
            const response: any = { result: 'success' };
            
            if (headerUpdate) {
                response.header = {
                    version: headerUpdate.version,
                    data: header!.data
                };
            }
            
            if (bodyUpdate) {
                response.body = {
                    version: bodyUpdate.version,
                    data: body!.data
                };
            }
            
            callback(response);
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', message: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in artifact-update');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Create new artifact
    socket.on('artifact-create', async (data: {
        id: string;
        header: string;
        body: string;
        dataEncryptionKey: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-create', ...labels });

            const parsed = artifactCreateSchema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: 'error', message: 'Invalid parameters' });
                return;
            }
            const result = await createArtifactWithQuota(userId, parsed.data);
            if (result.kind === 'foreign-id-conflict') {
                callback?.({ result: 'error', message: 'Artifact with this ID already exists for another account' });
                return;
            }
            const { artifact } = result;

            // Emit new-artifact event
            if (result.created) {
                const updSeq = await allocateUserSeq(userId);
                const newArtifactPayload = buildNewArtifactUpdate(artifact, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newArtifactPayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            // Return created artifact
            callback({
                result: 'success',
                artifact: {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(artifact.header),
                    headerVersion: artifact.headerVersion,
                    body: privacyKit.encodeBase64(artifact.body),
                    bodyVersion: artifact.bodyVersion,
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime()
                }
            });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                callback?.({ result: 'error', message: error.code });
                return;
            }
            log({ module: 'websocket', level: 'error', error }, 'Error in artifact-create');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    // Delete artifact
    socket.on('artifact-delete', async (data: {
        artifactId: string;
    }, callback: (response: any) => void) => {
        try {
            websocketEventsCounter.inc({ event_type: 'artifact-delete', ...labels });

            const idResult = artifactIdSchema.safeParse(data?.artifactId);
            if (!idResult.success) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const artifactId = idResult.data;

            // Check if artifact exists and belongs to user
            const artifact = await db.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: userId
                }
            });

            if (!artifact) {
                if (callback) {
                    callback({ result: 'error', message: 'Artifact not found' });
                }
                return;
            }

            // Delete artifact
            await db.artifact.delete({
                where: { id: artifactId }
            });

            // Emit delete-artifact event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteArtifactUpdate(artifactId, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Send success response
            callback({ result: 'success' });
        } catch (error) {
            log({ module: 'websocket', level: 'error', error }, 'Error in artifact-delete');
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });
}
