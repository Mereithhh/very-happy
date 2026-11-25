/**
 * B-974d: REST client for `/v1/plugins/*` (DESIGN B-973 §5.8). Same shape as
 * apiAttention.ts. An older server answers 404 on every route → callers hide
 * the whole plugin UI (§7 「新 Web + 旧 server」), never show an error.
 *
 * Responses are parsed leniently: unknown fields are ignored and malformed
 * rows dropped, so a newer server cannot break the page.
 */
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { OWNER_LOGIN_REQUIRED } from './apiAttention';
import {
  PluginAuditListResponseSchema,
  PluginInstallDetailSchema,
  PluginInstallViewSchema,
  PluginManifestSchema,
  PluginWidgetViewSchema,
  type PluginAuditListResponse,
  type PluginFrameTicketResponse,
  type PluginInstallView,
  type PluginManifest,
  type PluginPermission,
  type PluginWidgetActionResponse,
  type PluginWidgetView,
} from '@slopus/happy-wire';

/** `GET /v1/plugins/installs/:id` with its manifests parsed (wire sends them as `unknown`). */
export interface PluginReviewDetail {
  install: PluginInstallView;
  review: { manifest: PluginManifest; manifestHash: string; approvedManifest: PluginManifest | null; submittedAt: number | null; machineId: string };
}

export class PluginsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'PluginsApiError';
  }
}

/** Older server (no `/v1/plugins`) or feature off: hide everything. */
export function isPluginsUnavailable(error: unknown): boolean {
  if (!(error instanceof PluginsApiError) || error.status !== 404) return false;
  return error.code === 'http_404' || error.code === 'route_not_found' || error.code === 'plugins_disabled' || error.code === 'not_found_route';
}

type Method = 'GET' | 'POST' | 'DELETE';

async function request(path: string, method: Method = 'GET', body?: unknown): Promise<unknown> {
  const credentials = getCurrentAuth()?.credentials;
  if (!credentials) throw new PluginsApiError(401, 'unauthorized');
  const response = await fetch(`${getServerUrl()}/v1/plugins${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'X-Happy-Client': getHappyClientId(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 403) {
    const denied = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (denied?.error === OWNER_LOGIN_REQUIRED) throw new PluginsApiError(403, OWNER_LOGIN_REQUIRED);
  }
  assertNotAuthFailure(response, 'apiPlugins');
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    throw new PluginsApiError(response.status, typeof rec.error === 'string' ? rec.error : `http_${response.status}`, rec);
  }
  if (!data || typeof data !== 'object') throw new PluginsApiError(502, 'invalid_response');
  return data;
}

// ─── parsing: wire schemas, one row at a time ─────────────────────────────
// A row that fails its schema is dropped (never the whole list), so a newer
// server cannot break the page.

/** The install origin must be a bare scheme://host[:port]; anything else → null (panels off). */
function safeOrigin(origin: string | null | undefined): string | null {
  return origin && /^https?:\/\/[^/?#\s]+$/.test(origin) ? origin : null;
}

export function parseInstall(v: unknown): PluginInstallView | null {
  const r = PluginInstallViewSchema.safeParse(v);
  return r.success ? { ...r.data, origin: safeOrigin(r.data.origin) } : null;
}

export function parseWidget(v: unknown): PluginWidgetView | null {
  const r = PluginWidgetViewSchema.safeParse(v);
  return r.success ? r.data : null;
}

function parseManifest(v: unknown): PluginManifest | null {
  const r = PluginManifestSchema.safeParse(v);
  return r.success ? r.data : null;
}

function rows<T>(v: unknown, parse: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const p = parse(x);
    if (p !== null) out.push(p);
  }
  return out;
}

function field(data: unknown, key: string): unknown {
  return data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
}

function installOf(data: unknown): PluginInstallView {
  const i = parseInstall(field(data, 'install'));
  if (!i) throw new PluginsApiError(502, 'invalid_response');
  return i;
}

// ─── routes ────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export async function listPluginInstalls(): Promise<PluginInstallView[]> {
  return rows(field(await request('/installs'), 'installs'), parseInstall);
}

export async function getPluginInstall(id: string): Promise<PluginReviewDetail> {
  const parsed = PluginInstallDetailSchema.safeParse(await request(`/installs/${enc(id)}`));
  const install = parsed.success ? parseInstall(parsed.data.install) : null;
  const manifest = parsed.success ? parseManifest(parsed.data.review.manifest) : null;
  if (!parsed.success || !install || !manifest) throw new PluginsApiError(502, 'invalid_response');
  const r = parsed.data.review;
  return { install, review: { manifest, manifestHash: r.manifestHash, approvedManifest: parseManifest(r.approvedManifest), submittedAt: r.submittedAt ?? null, machineId: r.machineId } };
}

export async function approvePluginInstall(id: string, grants: PluginPermission[], manifestHash: string): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/approve`, 'POST', { grants, manifestHash }));
}

export async function rejectPluginInstall(id: string): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/reject`, 'POST', {}));
}

export async function disablePluginInstall(id: string, reason?: string): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/disable`, 'POST', reason ? { reason } : {}));
}

export async function enablePluginInstall(id: string): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/enable`, 'POST', {}));
}

export async function removePluginInstall(id: string): Promise<void> {
  await request(`/installs/${enc(id)}`, 'DELETE');
}

export async function revokePluginGrants(id: string, revoke: PluginPermission[]): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/grants`, 'POST', { revoke }));
}

export async function setPluginMuted(id: string, muted: boolean): Promise<PluginInstallView> {
  return installOf(await request(`/installs/${enc(id)}/mute`, 'POST', { muted }));
}

export async function getPluginAudit(id: string): Promise<PluginAuditListResponse> {
  const r = PluginAuditListResponseSchema.safeParse(await request(`/installs/${enc(id)}/audit?limit=100`));
  if (!r.success) throw new PluginsApiError(502, 'invalid_response');
  return r.data;
}

export async function createFrameTicket(id: string, panelId: string, path?: string | null): Promise<Pick<PluginFrameTicketResponse, 'ticket' | 'url'>> {
  const data = await request(`/installs/${enc(id)}/frame-ticket`, 'POST', path ? { panelId, path } : { panelId });
  const ticket = field(data, 'ticket');
  const url = field(data, 'url');
  if (typeof ticket !== 'string' || typeof url !== 'string') throw new PluginsApiError(502, 'invalid_response');
  return { ticket, url };
}

export async function listSessionWidgets(sessionId: string): Promise<PluginWidgetView[]> {
  return rows(field(await request(`/widgets?sessionId=${enc(sessionId)}`), 'widgets'), parseWidget);
}

export async function sendWidgetAction(installId: string, sessionId: string, actionId: string): Promise<{ eventId: string | null }> {
  const eventId = field(await request(`/widgets/${enc(installId)}/${enc(sessionId)}/action`, 'POST', { actionId }), 'eventId') as PluginWidgetActionResponse['eventId'] | undefined;
  return { eventId: typeof eventId === 'string' ? eventId : null };
}
