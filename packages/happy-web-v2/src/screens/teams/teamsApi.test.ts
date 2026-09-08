import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/auth/AuthContext", () => ({
  getCurrentAuth: () => ({ credentials: { token: "test-token" } }),
}));
vi.mock("@/sync/serverConfig", () => ({
  getServerUrl: () => "http://localhost:3005",
}));
import { actOnTeam, createTeam, listTeams, TeamsApiError } from "@/sync/teams";
afterEach(() => vi.unstubAllGlobals());
describe("teams API", () => {
  it("preserves the same action identity when the caller retries an ambiguous response", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ team: { id: "team" } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const action = {
      type: "delegate" as const,
      goal: "Ship",
      acceptance: ["tests pass"],
    };
    await expect(actOnTeam("team", action, "request-1")).rejects.toThrow(
      "network",
    );
    await actOnTeam("team", action, "request-1");
    expect(fetcher.mock.calls[0][1].body).toEqual(
      fetcher.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      action,
      requestId: "request-1",
    });
  });
  it("reports unavailable servers instead of rendering an empty team list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );
    await expect(listTeams()).rejects.toMatchObject({
      status: 404,
      code: "http_404",
    } satisfies Partial<TeamsApiError>);
  });
  it("sends create identity and auth through the official API", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ team: {} }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await createTeam("Team", "machine", "create-1");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      name: "Team",
      machineId: "machine",
      requestId: "create-1",
    });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer test-token",
    );
  });
});
