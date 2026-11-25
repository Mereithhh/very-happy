/**
 * B-974d (DESIGN B-973 §1 E3, §5.3, §7): plugin decision cards in
 * 「需要我决策」.
 *
 * Plugin items are AttentionItems with `source: 'plugin'`, `pluginInstallId`
 * and (usually) no `sessionId`, so they cannot live in attentionStore's
 * per-session map. They are fetched with `?include=plugin` (the server only
 * returns sessionless items to clients that ask — §7) and the matching
 * `attention-item` socket updates are routed here before the shared
 * `ApiUpdateSchema` (which still requires a sessionId) sees them.
 */
import { create } from 'zustand';
import { getCurrentAuth } from '@/auth/AuthContext';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';
import { AttentionApiError, OWNER_LOGIN_REQUIRED } from './apiAttention';
import {
  ATTENTION_INCLUDE_PLUGIN,
  ATTENTION_OWNER_SYSTEM_SOURCE,
  ATTENTION_PLUGIN_SOURCE,
  AttentionItemAnySchema,
  attentionLinkedSessionId,
  isAttentionActive,
  isAttentionPluginItem,
  parsePluginPayload,
  type AttentionItemOwnerRespond,
} from '@slopus/happy-wire';

export type PluginDecisionKind = 'choice' | 'input' | 'notice';
export type PluginDecisionState = 'open' | 'responded' | 'closed';

export interface PluginDecisionOption {
  id: string;
  label: string;
  style: 'default' | 'primary' | 'danger';
  detail?: string;
}

export interface PluginDecisionView {
  id: string;
  installId: string;
  kind: PluginDecisionKind;
  title: string;
  bodyMd: string | null;
  options: PluginDecisionOption[];
  input: { placeholder?: string; maxLength: number; multiline: boolean } | null;
  state: PluginDecisionState;
  response: { choice?: string | null; text?: string | null; at?: number | null } | null;
  delivery: 'pending' | 'delivered' | 'failed' | null;
  /** plugin has not acknowledged the response for 24h (server-computed or derived) */
  unacknowledged: boolean;
  panelPath: string | null;
  /** related session, from `links` (r4) */
  sessionId: string | null;
  /** server-written source fields (payload); the card prefers the live install view */
  pluginName: string | null;
  machineId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const DAY = 24 * 3600_000;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * AttentionItem (source plugin) → card view, read with the wire schemas:
 * `AttentionItemAnySchema` (sessionId may be null) and `parsePluginPayload`
 * (DESIGN r5: the item only adds `pluginInstallId`; decisionKind,
 * optionStyles, input, panelPath, pluginState, delivery, response,
 * unacknowledged, pluginName and machineId live in `payload`). The related
 * session is the `session` link (r4, `attentionLinkedSessionId`). An item that
 * fails either schema is dropped.
 */
export function parsePluginDecision(v: unknown, now = Date.now()): PluginDecisionView | null {
  const parsed = AttentionItemAnySchema.safeParse(v);
  if (!parsed.success) return null;
  const r = parsed.data;
  if (r.source !== ATTENTION_PLUGIN_SOURCE || !r.pluginInstallId) return null;
  const p = parsePluginPayload(r.payload);
  if (!p) return null;
  const kind: PluginDecisionKind = p.decisionKind === 'input' ? 'input' : p.decisionKind === 'notice' ? 'notice' : 'choice';
  const styles = p.optionStyles ?? {};
  const options: PluginDecisionOption[] = (r.options ?? []).map((o) => {
    const style = styles[o.id];
    return { id: o.id, label: o.label, style: style === 'primary' || style === 'danger' ? style : 'default', detail: o.detail ?? undefined };
  });
  const input = kind === 'input' ? { placeholder: p.input?.placeholder, maxLength: Math.min(2000, Math.max(1, p.input?.maxLength ?? 500)), multiline: p.input?.multiline === true } : null;
  const state: PluginDecisionState = p.pluginState === 'responded' || p.pluginState === 'closed' ? p.pluginState : 'open';
  const response = state === 'open' ? null : { choice: p.response?.choice ?? r.ownerChoice ?? null, text: p.response?.text ?? null, at: p.response?.at ?? r.resolvedAt ?? null };
  const delivery = p.delivery === 'pending' || p.delivery === 'delivered' || p.delivery === 'failed' ? p.delivery : null;
  const respondedAt = response?.at ?? null;
  const unacknowledged = p.unacknowledged === true || (state === 'responded' && delivery !== 'failed' && delivery !== 'delivered' && respondedAt !== null && now - respondedAt > DAY);
  return {
    id: r.id,
    installId: r.pluginInstallId,
    kind,
    title: r.title,
    bodyMd: r.bodyMd,
    options: kind === 'choice' ? options.slice(0, 4) : [],
    input,
    state,
    response,
    delivery,
    unacknowledged,
    panelPath: p.panelPath ?? null,
    sessionId: attentionLinkedSessionId(r),
    pluginName: p.pluginName,
    machineId: p.machineId,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** 「插件安装待批准」 (source `owner-system`, server-generated): a card that opens the review page. */
export interface OwnerSystemCard {
  id: string;
  installId: string | null;
  title: string;
  bodyMd: string | null;
  open: boolean;
  version: number;
  updatedAt: number;
}

export function parseOwnerSystemCard(v: unknown): OwnerSystemCard | null {
  const parsed = AttentionItemAnySchema.safeParse(v);
  if (!parsed.success || parsed.data.source !== ATTENTION_OWNER_SYSTEM_SOURCE) return null;
  const r = parsed.data;
  return { id: r.id, installId: r.pluginInstallId ?? null, title: r.title, bodyMd: r.bodyMd, open: isAttentionActive(r.state), version: r.version, updatedAt: r.updatedAt };
}

interface DecisionState {
  disabled: boolean;
  items: Record<string, PluginDecisionView>;
  system: Record<string, OwnerSystemCard>;
}

export const usePluginDecisions = create<DecisionState>(() => ({ disabled: false, items: {}, system: {} }));

export function applyOwnerSystemCard(c: OwnerSystemCard): void {
  usePluginDecisions.setState((s) => {
    const cur = s.system[c.id];
    if (cur && cur.version > c.version) return s;
    return { system: { ...s.system, [c.id]: c } };
  });
}

export function applyPluginDecision(d: PluginDecisionView): void {
  usePluginDecisions.setState((s) => {
    const cur = s.items[d.id];
    if (cur && cur.version > d.version) return s;
    return { items: { ...s.items, [d.id]: d } };
  });
}

/** Socket `attention-item` with a plugin source → handled here (true); anything else → false. */
export function handlePluginAttentionUpdate(body: unknown): boolean {
  const b = rec(body);
  if (!b || b.t !== 'attention-item') return false;
  const item = rec(b.item);
  if (!item) return false;
  // wire isAttentionPluginItem: plugin / owner-system / pluginInstallId / sessionId null — never session code.
  if (!isAttentionPluginItem(item as { source: string; sessionId?: string | null; pluginInstallId?: string | null })) return false;
  const c = parseOwnerSystemCard(item);
  if (c) applyOwnerSystemCard(c);
  const d = parsePluginDecision(item);
  if (d) applyPluginDecision(d);
  return true;
}

async function request(path: string, body?: unknown): Promise<unknown> {
  const credentials = getCurrentAuth()?.credentials;
  if (!credentials) throw new AttentionApiError(401, 'unauthorized');
  const response = await fetch(`${getServerUrl()}/v1/attention-items${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 403) {
    const denied = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (denied?.error === OWNER_LOGIN_REQUIRED) throw new AttentionApiError(403, OWNER_LOGIN_REQUIRED);
  }
  assertNotAuthFailure(response, 'apiPluginDecisions');
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new AttentionApiError(response.status, (data as { error?: string } | null)?.error ?? `http_${response.status}`);
  return data;
}

/** Open + latest answered plugin items. 404 (board off / older server) → nothing renders. */
export async function loadPluginDecisions(): Promise<void> {
  if (usePluginDecisions.getState().disabled) return;
  try {
    const data = rec(await request(`?state=active&include=${ATTENTION_INCLUDE_PLUGIN}&limit=200`));
    const items: Record<string, PluginDecisionView> = {};
    const system: Record<string, OwnerSystemCard> = {};
    for (const raw of Array.isArray(data?.items) ? data.items : []) {
      const d = parsePluginDecision(raw);
      if (d) items[d.id] = d;
      const c = parseOwnerSystemCard(raw);
      if (c) system[c.id] = c;
    }
    // Socket snapshots that raced the fetch keep their higher version.
    const live = usePluginDecisions.getState().items;
    for (const [id, d] of Object.entries(live)) if (!items[id] || items[id].version < d.version) items[id] = d;
    usePluginDecisions.setState({ items, system });
  } catch (e) {
    if (e instanceof AttentionApiError && e.status === 404) usePluginDecisions.setState({ disabled: true, items: {}, system: {} });
  }
}

export type PluginDecisionResponse = Extract<AttentionItemOwnerRespond, { action: 'choose' | 'submit' | 'resolve' }>;

/** owner-respond (DESIGN §5.8: `submit { text }` is new for input cards; a notice's 「知道了」 is `resolve`). */
export async function respondToPluginDecision(d: PluginDecisionView, body: PluginDecisionResponse): Promise<void> {
  const data = rec(await request(`/${encodeURIComponent(d.id)}/owner-respond`, body));
  const next = parsePluginDecision(data?.item);
  if (next) applyPluginDecision(next);
}
