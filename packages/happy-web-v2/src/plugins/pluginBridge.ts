/**
 * B-974d: the panel ⇄ host postMessage bridge (DESIGN B-973 §4.4).
 *
 * Pure and DOM-free so the security rules are unit-testable and
 * mutation-checked:
 * - only messages whose `source` is this iframe's window AND whose `origin` is
 *   this install's origin are handled; everything else is ignored silently;
 * - replies go to that origin, never `*`;
 * - every call re-reads the install (no cached grant) and checks the
 *   permission(s) the method needs;
 * - at most 20 calls per second per iframe.
 * The bridge has no data-reading method: hello returns no token, account or
 * session data. Message shapes, the method list and the permission rule come
 * from `@slopus/happy-wire` (PluginBridgeRequestSchema,
 * pluginBridgeRequiredPermissions, PluginBridgeHello / PluginBridgeEvent).
 */
import {
  PLUGIN_API_VERSION,
  PLUGIN_BRIDGE_METHODS,
  PluginBridgeRequestSchema,
  pluginBridgeRequiredPermissions,
  type PluginBridgeEvent,
  type PluginBridgeHello,
  type PluginBridgeRequest,
} from '@slopus/happy-wire';
import { hasGrant, isLiveState, type PluginInstallView, type PluginPermission } from './pluginTypes';

export const BRIDGE_RATE_LIMIT = 20;
export const BRIDGE_RATE_WINDOW_MS = 1000;

export type BridgeErrorCode =
  | 'invalid_request'
  | 'unknown_method'
  | 'permission_denied'
  | 'plugin_disabled'
  | 'rate_limited'
  | 'session_not_on_machine'
  | 'not_found'
  | 'cancelled';

export interface BridgeError {
  code: BridgeErrorCode;
  message?: string;
  permission?: PluginPermission;
}

export type BridgeReply = { vh: 1; id: string | number; ok: true; result: unknown } | { vh: 1; id: string | number; ok: false; error: BridgeError };

export interface BridgeHost {
  /** the install as it is NOW (store read) — called on every message */
  getInstall(): PluginInstallView | null;
  theme(): 'light' | 'dark';
  locale(): string;
  mobile(): boolean;
  setTitle(title: string): void;
  navigatePanel(panelId: string, path: string | null): void;
  /** true when the session exists and lives on `machineId` */
  isSessionOnMachine(sessionId: string, machineId: string): boolean;
  navigateSession(sessionId: string): void;
  /** shows the host confirm with the full URL; resolves true when the owner confirmed */
  confirmExternal(url: string): Promise<boolean>;
  openExternal(url: string): void;
  refreshBadge(): void;
}

export interface BridgeMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** Sliding-window limiter: `limit` calls per `windowMs`. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  take(now: number): boolean {
    const floor = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0] <= floor) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
}

/** Exact origin equality after normalising the configured origin (no trailing slash, lowercase scheme/host). */
export function normalizeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** https only, parseable, no credentials. */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class PluginBridge {
  private readonly limiter = new RateLimiter(BRIDGE_RATE_LIMIT, BRIDGE_RATE_WINDOW_MS);
  private readonly origin: string | null;
  private themeSubscribed = false;

  constructor(
    private readonly opts: {
      origin: string;
      panelId: string;
      /** the iframe's contentWindow, read at message time (it changes on reload) */
      frameWindow: () => BridgeTarget | null;
      host: BridgeHost;
      now?: () => number;
    },
  ) {
    this.origin = normalizeOrigin(opts.origin);
  }

  /** Is this event ours? Both checks are required (§4.4). */
  accepts(event: BridgeMessageEvent): boolean {
    if (!this.origin) return false;
    const frame = this.opts.frameWindow();
    if (!frame || event.source !== frame) return false;
    if (event.origin !== this.origin) return false;
    return true;
  }

  /** Window `message` listener body. Returns the reply it posted (for tests), or null when ignored. */
  async handle(event: BridgeMessageEvent): Promise<BridgeReply | null> {
    if (!this.accepts(event)) return null;
    const data = event.data;
    if (!isRecord(data) || data.vh !== 1) return null;
    const id = data.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    if (typeof id === 'string' && id.length > 64) return null;
    const now = (this.opts.now ?? Date.now)();
    if (!this.limiter.take(now)) return this.reply(id, { code: 'rate_limited' });
    if (typeof data.method !== 'string' || !(PLUGIN_BRIDGE_METHODS as readonly string[]).includes(data.method)) return this.reply(id, { code: 'unknown_method' });
    const parsed = PluginBridgeRequestSchema.safeParse(data);
    if (!parsed.success) return this.reply(id, { code: 'invalid_request', message: parsed.error.issues[0]?.message });
    const req = parsed.data;
    // Current grant, never cached.
    const install = this.opts.host.getInstall();
    if (!install || !isLiveState(install.state)) return this.reply(id, { code: 'plugin_disabled' });
    for (const permission of pluginBridgeRequiredPermissions(req)) {
      if (!hasGrant(install, permission)) return this.reply(id, { code: 'permission_denied', permission });
    }
    try {
      const result = await this.dispatch(req, install);
      if (result && typeof result === 'object' && 'error' in result) return this.reply(id, (result as { error: BridgeError }).error);
      return this.reply(id, null, result ?? null);
    } catch {
      return this.reply(id, { code: 'invalid_request' });
    }
  }

  /** Host → panel notification (theme changes), only after host.theme.subscribe. */
  notifyTheme(theme: 'light' | 'dark'): boolean {
    if (!this.themeSubscribed) return false;
    const install = this.opts.host.getInstall();
    if (!hasGrant(install, 'panel')) return false;
    const event: PluginBridgeEvent = { vh: 1, event: 'host.themeChanged', params: { theme } };
    return this.post(event);
  }

  private async dispatch(req: PluginBridgeRequest, install: PluginInstallView): Promise<unknown> {
    const host = this.opts.host;
    switch (req.method) {
      case 'host.hello': {
        const hello: PluginBridgeHello = { apiVersion: PLUGIN_API_VERSION, theme: host.theme(), locale: host.locale(), installId: install.id, panelId: this.opts.panelId, mobile: host.mobile() };
        return hello;
      }
      case 'host.theme.subscribe':
        this.themeSubscribed = true;
        return { theme: host.theme() };
      case 'host.setTitle':
        host.setTitle(req.params.title);
        return { title: req.params.title };
      case 'host.navigate': {
        const p = req.params;
        if (p.to === 'panel') {
          if (!install.panels.some((x) => x.id === p.panelId)) return { error: { code: 'not_found', message: 'panelId' } };
          host.navigatePanel(p.panelId, p.path ?? null);
          return { navigated: true };
        }
        // `session.widget` is already required by pluginBridgeRequiredPermissions.
        if (!host.isSessionOnMachine(p.sessionId, install.machineId)) return { error: { code: 'session_not_on_machine' } };
        host.navigateSession(p.sessionId);
        return { navigated: true };
      }
      case 'host.openExternal': {
        const url = externalUrl(req.params.url);
        if (!url) return { error: { code: 'invalid_request', message: 'url must be https' } };
        const ok = await host.confirmExternal(url);
        if (!ok) return { error: { code: 'cancelled' } };
        // Re-check after the (possibly long) confirm: the owner may have disabled the plugin meanwhile.
        if (!hasGrant(host.getInstall(), 'panel')) return { error: { code: 'plugin_disabled' } };
        host.openExternal(url);
        return { opened: true };
      }
      case 'host.badge.refresh':
        host.refreshBadge();
        return { refreshed: true };
    }
  }

  private reply(id: string | number, error: BridgeError | null, result?: unknown): BridgeReply {
    const msg: BridgeReply = error ? { vh: 1, id, ok: false, error } : { vh: 1, id, ok: true, result };
    this.post(msg);
    return msg;
  }

  private post(message: unknown): boolean {
    const frame = this.opts.frameWindow();
    if (!frame || !this.origin) return false;
    // targetOrigin is the install's origin, never '*'.
    frame.postMessage(message, this.origin);
    return true;
  }
}
