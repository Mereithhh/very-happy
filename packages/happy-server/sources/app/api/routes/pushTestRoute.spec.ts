/** B-570: POST /v1/push/test — auth, per-account 1/10s limit, result passthrough. */
import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const sendTestSpy = vi.hoisted(() => vi.fn(async (_userId: string, _copy: { title: string; body: string }) => ({
    configured: true, total: 2, sent: 1, failed: 1, pruned: 1,
})));

vi.mock("@/storage/db", () => ({ db: {} }));
vi.mock("@/app/push/pushDispatch", () => ({
    dispatchSessionEventPush: vi.fn(),
    dispatchDeviceEventPush: vi.fn(),
    sendTestWebPush: sendTestSpy,
}));
vi.mock("@/app/push/webPush", () => ({ getVapidPublicKey: () => null, webPushConfigured: () => false }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
    buildSessionEventEphemeral: vi.fn(() => ({})),
}));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { pushRoutes } from "./pushRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") return reply.code(401).send({ error: "Unauthorized" });
        request.userId = userId;
    });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

describe("POST /v1/push/test", () => {
    it("requires auth", async () => {
        const app = await createApp();
        const res = await app.inject({ method: "POST", url: "/v1/push/test", payload: {} });
        expect(res.statusCode).toBe(401);
        expect(sendTestSpy).not.toHaveBeenCalled();
    });

    it("returns the fan-out counts, passes localized copy, and limits to 1 per 10s per account", async () => {
        const app = await createApp();
        const first = await app.inject({
            method: "POST", url: "/v1/push/test", headers: { "x-user-id": "u1" },
            payload: { title: "测试通知", body: "能看到就说明通了" },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ configured: true, total: 2, sent: 1, failed: 1, pruned: 1 });
        expect(sendTestSpy).toHaveBeenLastCalledWith("u1", { title: "测试通知", body: "能看到就说明通了" });

        const second = await app.inject({ method: "POST", url: "/v1/push/test", headers: { "x-user-id": "u1" }, payload: {} });
        expect(second.statusCode).toBe(429);
        expect(second.json()).toEqual({ error: "rate_limited" });

        // another account is not affected; no body → default copy
        const other = await app.inject({ method: "POST", url: "/v1/push/test", headers: { "x-user-id": "u2" } });
        expect(other.statusCode, other.body).toBe(200);
        expect(sendTestSpy.mock.calls.at(-1)?.[1].title).toMatch(/test/i);
        expect(sendTestSpy).toHaveBeenCalledTimes(2);
    });
});
