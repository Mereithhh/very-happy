import { MODEL_CHANNELS_PATH } from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { instanceConfig } from '@/app/instance/instanceConfig';
import { requestTokenKind } from '@/app/auth/tokenKind';
import { visibleModelChannels } from '@/app/modelChannels/modelChannels';

/**
 * B-981 `GET /v1/model-channels`: the operator's global model channels this
 * account may use. Machine tokens (daemons) get each channel's key; Web tokens
 * never do. Nothing here logs a key; responses are not cacheable.
 */
export function modelChannelsRoutes(app: Fastify) {
    app.get(MODEL_CHANNELS_PATH, { preHandler: app.authenticate }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        return visibleModelChannels(instanceConfig(), request.userId, requestTokenKind(request));
    });
}
