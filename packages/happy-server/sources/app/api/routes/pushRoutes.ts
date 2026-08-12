import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import { getVapidPublicKey, webPushConfigured } from "@/app/push/webPush";
import {
    WEBHOOK_EVENTS,
    WEBHOOK_TOKEN_PREFIX,
    WEBHOOK_URL_MAX_LENGTH,
    buildManualWebhookPayload,
    buildWebhookToken,
    createAccountRateLimiter,
    logWebhookResult,
    parseWebhookToken,
    sendWebhook,
    validateWebhookUrl,
} from "@/app/push/webhookNotify";
import { buildSessionEventEphemeral, eventRouter } from "@/app/events/eventRouter";

export function pushRoutes(app: Fastify) {

    // Web Push VAPID public key — the browser needs this as applicationServerKey
    // before it can subscribe. Public by definition; no auth required.
    app.get('/v1/web-push/vapid-public-key', async (_request, reply) => {
        return reply.send({
            configured: webPushConfigured(),
            publicKey: getVapidPublicKey() || null,
        });
    });

    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                400: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;

        // Webhook configs have their own endpoint with URL validation and
        // replace semantics — don't let them sneak in unvalidated here.
        if (token.startsWith(WEBHOOK_TOKEN_PREFIX)) {
            return reply.code(400).send({ error: 'Use /v1/webhook to configure webhook notifications' });
        }

        try {
            await db.accountPushToken.upsert({
                where: {
                    accountId_token: {
                        accountId: userId,
                        token: token
                    }
                },
                update: {
                    updatedAt: new Date()
                },
                create: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Session-Event Push API
    // CLI/daemon clients call this instead of talking to Expo directly so the
    // server can apply presence-based suppression (active desktop/web/mobile).
    app.post('/v1/sessions/:sessionId/push-event', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                kind: z.enum(['done', 'permission', 'question']),
                title: z.string().min(1).max(200),
                body: z.string().min(1).max(500),
                data: z.record(z.string(), z.unknown()).optional()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Session not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { kind, title, body, data } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Fan out the event to user's connected clients (web tabs use this to
        // bump tab-title unread counter for "user attention needed" moments only,
        // instead of pinging on every encrypted message).
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, title, body),
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        void dispatchSessionEventPush({
            userId,
            sessionId,
            title,
            body,
            data: { ...(data ?? {}), kind }
        });

        return reply.send({ success: true });
    });

    // Account webhook notification config.
    // Stored in AccountPushToken as a `webhook:`-prefixed JSON blob (same
    // zero-migration trick as `webpush:`). Replace semantics: an account has
    // at most one webhook — POST deletes any existing `webhook:` rows before
    // creating the new one, so repeated saves never accumulate.
    const webhookConfigSchema = z.object({
        url: z.string(),
        events: z.array(z.enum(WEBHOOK_EVENTS)),
    });

    app.get('/v1/webhook', {
        schema: {
            response: {
                200: z.object({
                    webhook: webhookConfigSchema.nullable()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const rows = await db.accountPushToken.findMany({
            where: {
                accountId: request.userId,
                token: { startsWith: WEBHOOK_TOKEN_PREFIX }
            }
        });
        const webhook = rows.map(r => parseWebhookToken(r.token)).find(c => c !== null) ?? null;
        return reply.send({ webhook });
    });

    app.post('/v1/webhook', {
        schema: {
            body: z.object({
                url: z.string().min(1).max(WEBHOOK_URL_MAX_LENGTH),
                events: z.array(z.enum(WEBHOOK_EVENTS)).max(WEBHOOK_EVENTS.length).optional()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                400: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const url = request.body.url.trim();
        const invalid = validateWebhookUrl(url);
        if (invalid) {
            return reply.code(400).send({ error: invalid });
        }
        const events = [...new Set(request.body.events ?? [...WEBHOOK_EVENTS])];
        const token = buildWebhookToken({ url, events });
        await db.$transaction([
            db.accountPushToken.deleteMany({
                where: { accountId: userId, token: { startsWith: WEBHOOK_TOKEN_PREFIX } }
            }),
            db.accountPushToken.create({
                data: { accountId: userId, token }
            })
        ]);
        return reply.send({ success: true });
    });

    // Manual + automatic webhook notification.
    //  - MANUAL (web-initiated, e.g. "mark done" on the task board; no `event`
    //    field): the web CANNOT post to the user's webhook itself — the URL is
    //    server-side state and delivery must go through the SSRF guard — so it
    //    asks the server to forward a small {title,message} through the
    //    account's configured webhook. No events-category filtering: the
    //    completed/permission toggles gate AUTOMATIC events; an explicit user
    //    action is always wanted.
    //  - AUTOMATIC (daemon-initiated, carries `event`; today: web-terminal
    //    agent transitions): filtered by the account webhook config's `events`
    //    subscription — unsubscribed events return delivered:false without
    //    sending. `link` is a web-app path appended as a clickable 链接 line
    //    (see buildManualWebhookPayload). Old clients send neither field and
    //    keep the manual behavior — bidirectional compatibility by design.
    // Best-effort like every webhook send. Rate-limited per account so a
    // scripted client can't turn the server into a request cannon.
    const allowNotify = createAccountRateLimiter({ max: 30, windowMs: 60_000 });

    app.post('/v1/webhook/notify', {
        schema: {
            body: z.object({
                title: z.string().min(1).max(200),
                message: z.string().max(1000).optional(),
                sessionId: z.string().max(200).optional(),
                taskId: z.string().max(200).optional(),
                event: z.enum(WEBHOOK_EVENTS).optional(),
                link: z.string().max(300).startsWith('/').optional(),
            }),
            response: {
                200: z.object({
                    ok: z.literal(true),
                    // false = no webhook configured, or delivery failed
                    delivered: z.boolean()
                }),
                429: z.object({
                    error: z.string()
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        if (!allowNotify.allow(userId)) {
            return reply.code(429).send({ error: 'Too many notifications, slow down' });
        }
        const rows = await db.accountPushToken.findMany({
            where: {
                accountId: userId,
                token: { startsWith: WEBHOOK_TOKEN_PREFIX }
            }
        });
        const config = rows.map(r => parseWebhookToken(r.token)).find(c => c !== null) ?? null;
        if (!config) {
            // Not an error: a user without a webhook clicking "done" should
            // never see a failure — the notification is simply not wired up.
            return reply.send({ ok: true, delivered: false });
        }
        // Automatic events respect the account's event-subscription toggles;
        // manual notifications (no `event`) are always wanted.
        if (request.body.event && !config.events.includes(request.body.event)) {
            return reply.send({ ok: true, delivered: false });
        }
        const payload = buildManualWebhookPayload(request.body);
        const res = await sendWebhook(config.url, payload);
        logWebhookResult(userId, request.body.sessionId ?? '-', res);
        return reply.send({ ok: true, delivered: res.ok });
    });

    app.delete('/v1/webhook', {
        schema: {
            response: {
                200: z.object({
                    success: z.literal(true)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        await db.accountPushToken.deleteMany({
            where: {
                accountId: request.userId,
                token: { startsWith: WEBHOOK_TOKEN_PREFIX }
            }
        });
        return reply.send({ success: true });
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}