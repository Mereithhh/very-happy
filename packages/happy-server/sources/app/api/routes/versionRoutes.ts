import { z } from "zod";
import { type Fastify } from "../types";
import * as semver from 'semver';
import { ANDROID_UP_TO_DATE, IOS_UP_TO_DATE } from "@/versions";
import { CliVersionPolicyProvider, resolveCliVersionPolicyConfig } from '../cliVersionPolicy';

export function versionRoutes(app: Fastify) {
    // Validate operator policy while routes are registered so a typo fails at
    // startup instead of silently publishing a misleading compatibility gate.
    const cliPolicy = new CliVersionPolicyProvider(resolveCliVersionPolicyConfig());

    app.get('/v1/version/cli', {
        schema: {
            response: {
                200: z.object({
                    recommendedVersion: z.string().nullable(),
                    minimumVersion: z.string().nullable(),
                    checkedAt: z.number(),
                    source: z.enum(['configured', 'registry', 'unavailable']),
                }),
            },
        },
    }, async (_request, reply) => {
        reply.header('cache-control', 'public, max-age=300');
        reply.send(await cliPolicy.get());
    });

    app.post('/v1/version', {
        schema: {
            body: z.object({
                platform: z.string(),
                version: z.string(),
                app_id: z.string()
            }),
            response: {
                200: z.object({
                    updateUrl: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const { platform, version, app_id } = request.body;

        // Check ios
        if (platform.toLowerCase() === 'ios') {
            if (semver.satisfies(version, IOS_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: 'https://apps.apple.com/us/app/happy-claude-code-client/id6748571505' });
            }
            return;
        }

        // Check android
        if (platform.toLowerCase() === 'android') {
            if (semver.satisfies(version, ANDROID_UP_TO_DATE)) {
                reply.send({ updateUrl: null });
            } else {
                reply.send({ updateUrl: 'https://play.google.com/store/apps/details?id=com.ex3ndr.happy' });
            }
            return;
        }

        // Fallbacke
        reply.send({ updateUrl: null });
    });
}
