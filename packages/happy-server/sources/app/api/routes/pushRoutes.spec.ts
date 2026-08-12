/**
 * Route-level tests for POST /v1/webhook/notify — the manual/automatic
 * notification forwarder. Focus: the NEW optional `event` field (automatic
 * events are filtered by the account webhook config's `events` subscription;
 * manual notifications without `event` are never filtered) and the `link`
 * path (appended as a 链接 line by buildManualWebhookPayload). Old clients
 * send neither field and keep the exact legacy behavior.
 */
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { state, dbMock, resetState, sendWebhookSpy } = vi.hoisted(() => {
    const state = {
        // AccountPushToken rows returned for the webhook-config lookup.
        pushTokenRows: [] as Array<{ token: string }>,
    };
    const resetState = () => {
        state.pushTokenRows = [];
    };
    const dbMock = {
        accountPushToken: {
            findMany: vi.fn(async () => state.pushTokenRows),
            upsert: vi.fn(async () => ({})),
            deleteMany: vi.fn(async () => ({ count: 0 })),
            create: vi.fn(async () => ({})),
        },
        session: { findFirst: vi.fn(async () => null) },
        $transaction: vi.fn(async () => []),
    };
    const sendWebhookSpy = vi.fn(async (_url: string, _payload: { title: string; message: string }) => ({ ok: true, status: 200 }));
    return { state, dbMock, resetState, sendWebhookSpy };
});

// Keep the REAL webhookNotify logic (token parsing, payload building, rate
// limiter) but stub the outbound HTTP send so we can assert on the payload.
vi.mock("@/app/push/webhookNotify", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/push/webhookNotify")>();
    return { ...actual, sendWebhook: sendWebhookSpy };
});
vi.mock("@/storage/db", () => ({ db: dbMock }));
const deviceEventPushSpy = vi.hoisted(() =>
    vi.fn(async (_params: { userId: string; title: string; body: string; data?: Record<string, unknown> }) => undefined));
vi.mock("@/app/push/pushDispatch", () => ({
    dispatchSessionEventPush: vi.fn(async () => undefined),
    dispatchDeviceEventPush: deviceEventPushSpy,
}));
vi.mock("@/app/push/webPush", () => ({ getVapidPublicKey: () => null, webPushConfigured: () => false }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
    buildSessionEventEphemeral: vi.fn(() => ({})),
}));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { buildWebhookToken, type WebhookEvent } from "@/app/push/webhookNotify";
import { pushRoutes } from "./pushRoutes";

const WEBHOOK_URL = "https://hooks.example.com/ingest/tok";

function configureWebhook(events: WebhookEvent[]) {
    state.pushTokenRows = [{ token: buildWebhookToken({ url: WEBHOOK_URL, events }) }];
}

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

let seq = 0;
/** Fresh user per test: the route's per-account rate limiter is module-level
 *  state that survives across tests. */
function nextUser() {
    return `user-${++seq}`;
}

function notify(app: Fastify, payload: Record<string, unknown>, userId: string) {
    return app.inject({
        method: "POST",
        url: "/v1/webhook/notify",
        headers: { "x-user-id": userId },
        payload,
    });
}

describe("pushRoutes — POST /v1/webhook/notify event filtering & link", () => {
    let app: Fastify;
    const originalWebUrl = process.env.HAPPY_WEB_URL;
    beforeEach(async () => {
        resetState();
        sendWebhookSpy.mockClear();
        app = await createApp();
    });
    afterEach(async () => {
        if (app) await app.close();
        if (originalWebUrl === undefined) delete process.env.HAPPY_WEB_URL;
        else process.env.HAPPY_WEB_URL = originalWebUrl;
    });

    it("delivers an automatic event the account subscribed to", async () => {
        configureWebhook(["completed", "permission"]);
        const res = await notify(app, {
            title: "修 bug 的终端",
            message: "Claude 等待下一步指令",
            link: "/terminal/m1?tid=t1",
            event: "completed",
        }, nextUser());
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, delivered: true });
        expect(sendWebhookSpy).toHaveBeenCalledTimes(1);
        expect(sendWebhookSpy.mock.calls[0][0]).toBe(WEBHOOK_URL);
    });

    it("filters out an automatic event the account did NOT subscribe to", async () => {
        configureWebhook(["permission"]);
        const res = await notify(app, {
            title: "t",
            message: "m",
            event: "completed",
        }, nextUser());
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, delivered: false });
        expect(sendWebhookSpy).not.toHaveBeenCalled();
    });

    it("never filters a MANUAL notification (no event field), regardless of subscriptions", async () => {
        configureWebhook(["permission"]); // completed unsubscribed — irrelevant for manual
        const res = await notify(app, {
            title: "✅ 已完成 · fix tests",
            message: "已确认完成。",
            sessionId: "sess-1",
        }, nextUser());
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, delivered: true });
        expect(sendWebhookSpy).toHaveBeenCalledTimes(1);
        // Legacy payload shape is untouched: session trailer stays last.
        const payload = sendWebhookSpy.mock.calls[0][1] as { title: string; message: string };
        const lines = payload.message.split("\n");
        expect(lines[lines.length - 1]).toBe("session: sess-1");
    });

    it("appends the link line to the delivered payload when HAPPY_WEB_URL is set", async () => {
        process.env.HAPPY_WEB_URL = "https://happy.example.com";
        configureWebhook(["completed", "permission"]);
        const res = await notify(app, {
            title: "修 bug 的终端",
            message: "Claude 请求确认/需要输入",
            link: "/terminal/m1?tid=t1",
            event: "permission",
        }, nextUser());
        expect(res.json()).toEqual({ ok: true, delivered: true });
        const payload = sendWebhookSpy.mock.calls[0][1] as { title: string; message: string };
        expect(payload.title).toBe("修 bug 的终端");
        expect(payload.message.split("\n")).toEqual([
            "Claude 请求确认/需要输入",
            "链接：https://happy.example.com/terminal/m1?tid=t1",
        ]);
    });

    it("rejects a link that is not a web-app path (schema)", async () => {
        configureWebhook(["completed", "permission"]);
        const res = await notify(app, {
            title: "t",
            link: "https://evil.example.com/phish",
            event: "completed",
        }, nextUser());
        expect(res.statusCode).toBe(400);
        expect(sendWebhookSpy).not.toHaveBeenCalled();
    });

    it("rejects an unknown event value (schema)", async () => {
        configureWebhook(["completed", "permission"]);
        const res = await notify(app, { title: "t", event: "explosion" }, nextUser());
        expect(res.statusCode).toBe(400);
        expect(sendWebhookSpy).not.toHaveBeenCalled();
    });

    it("reports delivered:false without error when no webhook is configured (event or not)", async () => {
        state.pushTokenRows = [];
        const user = nextUser();
        const auto = await notify(app, { title: "t", event: "completed" }, user);
        expect(auto.json()).toEqual({ ok: true, delivered: false });
        const manual = await notify(app, { title: "t" }, user);
        expect(manual.json()).toEqual({ ok: true, delivered: false });
        expect(sendWebhookSpy).not.toHaveBeenCalled();
    });

    it("fans automatic events out to device pushes — even with NO webhook configured", async () => {
        deviceEventPushSpy.mockClear();
        state.pushTokenRows = [];
        const res = await notify(app, {
            title: "修 bug 的终端",
            message: "Claude 等待下一步指令",
            link: "/terminal/m1?tid=t1",
            event: "completed",
        }, nextUser());
        expect(res.statusCode).toBe(200);
        expect(deviceEventPushSpy).toHaveBeenCalledTimes(1);
        const call = deviceEventPushSpy.mock.calls[0][0];
        expect(call.title).toBe("修 bug 的终端");
        expect(call.body).toBe("Claude 等待下一步指令");
        expect(call.data).toEqual({ kind: "completed", url: "/terminal/m1?tid=t1" });
    });

    it("does NOT device-push manual notifications (no event field)", async () => {
        deviceEventPushSpy.mockClear();
        configureWebhook(["completed", "permission"]);
        const res = await notify(app, { title: "手动通知" }, nextUser());
        expect(res.statusCode).toBe(200);
        expect(deviceEventPushSpy).not.toHaveBeenCalled();
    });
});
