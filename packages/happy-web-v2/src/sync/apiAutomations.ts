/**
 * B-498: REST client for the account-level Automations API (B-496).
 *
 * Same shape as `teams.ts`: account token, JSON, `{ error }` bodies become
 * `AutomationsApiError`. The server returns 404 `automations_disabled` when
 * `VH_AUTOMATIONS_ENABLED` is off — callers treat that as "feature hidden",
 * never as a failure (see automationsStore.ts).
 */
import type { Automation, AutomationCreate, AutomationRun, AutomationSticky, AutomationUpdate } from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export class AutomationsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'AutomationsApiError';
  }
  /** feature gate off (or account not allow-listed) — hide, don't complain */
  get disabled(): boolean {
    return this.status === 404 && this.code === 'automations_disabled';
  }
}

export function isAutomationsDisabled(error: unknown): boolean {
  return error instanceof AutomationsApiError && error.disabled;
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const credentials = getCurrentAuth()?.credentials;
  if (!credentials) throw new AutomationsApiError(401, 'unauthorized');
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  const response = await fetch(`${getServerUrl()}/v1/automations${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'X-Happy-Client': getHappyClientId(),
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  assertNotAuthFailure(response, 'apiAutomations'); // B-490: 401/403 latch, never retried
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const { error, ...details } = (data ?? {}) as { error?: string } & Record<string, unknown>;
    throw new AutomationsApiError(response.status, error ?? `http_${response.status}`, details);
  }
  if (!data || typeof data !== 'object') throw new AutomationsApiError(502, 'invalid_response');
  return data as T;
}

export interface RunsQuery {
  automationId?: string;
  status?: string;
  attention?: boolean;
  limit?: number;
}

export const listAutomations = () => request<{ automations: Automation[] }>('');
export const getAutomation = (id: string) => request<{ automation: Automation }>(`/${encodeURIComponent(id)}`);
export const listRuns = (query: RunsQuery = {}) => {
  const params = new URLSearchParams();
  if (query.automationId) params.set('automationId', query.automationId);
  if (query.status) params.set('status', query.status);
  if (query.attention) params.set('attention', '1');
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return request<{ runs: AutomationRun[] }>(`/runs${qs ? `?${qs}` : ''}`);
};
export const getRun = (id: string) => request<{ run: AutomationRun }>(`/runs/${encodeURIComponent(id)}`);
export const cancelRun = (id: string) => request<{ run: AutomationRun }>(`/runs/${encodeURIComponent(id)}/cancel`, { body: {} });
export const ackRun = (id: string) => request<{ run: AutomationRun }>(`/runs/${encodeURIComponent(id)}/ack`, { body: {} });
export const pauseAutomation = (id: string) => request<{ automation: Automation }>(`/${encodeURIComponent(id)}/pause`, { body: {} });
export const resumeAutomation = (id: string) => request<{ automation: Automation }>(`/${encodeURIComponent(id)}/resume`, { body: {} });
/** manual run — allowed on paused automations too (explicit user intent) */
export const runAutomationNow = (id: string) => request<{ run: AutomationRun }>(`/${encodeURIComponent(id)}/run`, { body: {} });
export const deleteAutomation = (id: string) => request<{ ok: true }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const createAutomation = (body: AutomationCreate) => request<{ automation: Automation }>('', { body });
/** PATCH with the version the form was opened on — 409 `stale_automation` when it moved */
export const updateAutomation = (id: string, body: AutomationUpdate) => request<{ automation: Automation }>(`/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const listStickies = (id: string) => request<{ stickies: AutomationSticky[] }>(`/${encodeURIComponent(id)}/stickies`);
