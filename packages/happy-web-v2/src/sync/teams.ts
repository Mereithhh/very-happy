import type { TeamAction, TeamResponse, TeamState } from "@slopus/happy-wire";
import { getCurrentAuth } from "@/auth/AuthContext";
import { getServerUrl } from "./serverConfig";

export class TeamsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const credentials = getCurrentAuth()?.credentials;
  if (!credentials) throw new TeamsApiError(401, "unauthorized");
  const response = await fetch(`${getServerUrl()}/v1/teams${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new TeamsApiError(
      response.status,
      data?.error ?? `http_${response.status}`,
    );
  if (!data || typeof data !== "object")
    throw new TeamsApiError(502, "invalid_response");
  return data as T;
}
export const listTeams = () => request<{ teams: TeamState[] }>("");
export const getTeam = (id: string) =>
  request<{ team: TeamState }>(`/${encodeURIComponent(id)}`);
export const createTeam = (
  name: string,
  machineId: string,
  requestId: string,
) => request<{ team: TeamState }>("", { name, machineId, requestId });
/** Caller retains requestId on ambiguous failures; retrying cannot duplicate delegation. */
export const actOnTeam = (id: string, action: TeamAction, requestId: string) =>
  request<TeamResponse>(`/${encodeURIComponent(id)}/actions`, {
    requestId,
    action,
  });
