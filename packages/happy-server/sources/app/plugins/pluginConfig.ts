/**
 * B-974 Web plugins v1 — server switches (design B-973 §3.4, §7; docs/plugins.md).
 *
 *  - `VH_PLUGINS_ENABLED=1` turns plugins on for every account; `VH_PLUGINS_ENABLED_ACCOUNTS=<id,id>`
 *    for those accounts only (canary). Neither: every `/v1/plugins/*` route answers 404
 *    `plugins_disabled` (the "older server" path the Web hides the feature on), and machine
 *    `plugin-op`s are refused.
 *  - Kill switch: `VH_PLUGINS_DISABLED=1` stops every install (`disabled_by_operator`);
 *    `VH_PLUGIN_DENYLIST=<pluginId | sha256 manifest hash, …>` stops the matching ones. The owner
 *    cannot lift either. Read per call, so a config reload applies without a restart.
 *  - `VH_PLUGIN_HOST=p.example.com[:port]`: wildcard parent of the per-install panel origins
 *    (`<label>.p.example.com`). Unset: panels are unavailable; the other extension points work.
 *    `VH_PLUGIN_HOST_SCHEME=http` only for local development hosts (`*.localhost`).
 *  - `VH_PLUGIN_WEB_ORIGINS=<origin,origin>`: who may frame a panel (`frame-ancestors`). Unset: the
 *    `PUBLIC_URL` origin, else the Web origin that asked for the frame ticket.
 */

function truthy(value: string | undefined): boolean {
    const v = value?.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function list(value: string | undefined): string[] {
    return (value ?? '').split(',').map(part => part.trim()).filter(Boolean);
}

export function pluginsEnabledFor(accountId: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (truthy(env.VH_PLUGINS_ENABLED)) return true;
    return list(env.VH_PLUGINS_ENABLED_ACCOUNTS).includes(accountId);
}

/** The operator's verdict on one install: null when allowed. */
export function operatorBlock(install: { pluginId: string; manifestHash?: string | null; pendingManifestHash?: string | null }, env: NodeJS.ProcessEnv = process.env): 'all_disabled' | 'denylisted' | null {
    if (truthy(env.VH_PLUGINS_DISABLED)) return 'all_disabled';
    const deny = new Set(list(env.VH_PLUGIN_DENYLIST).map(entry => entry.toLowerCase()));
    if (deny.size === 0) return null;
    const keys = [install.pluginId, install.manifestHash, install.pendingManifestHash].filter((k): k is string => !!k).map(k => k.toLowerCase());
    return keys.some(k => deny.has(k)) ? 'denylisted' : null;
}

export interface PluginHostConfig {
    /** Lower-case `host[:port]` the per-install labels sit under. */
    host: string;
    scheme: 'https' | 'http';
}

export function pluginHostConfig(env: NodeJS.ProcessEnv = process.env): PluginHostConfig | null {
    const raw = env.VH_PLUGIN_HOST?.trim().toLowerCase().replace(/^\*\./, '');
    if (!raw || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(raw)) return null;
    return { host: raw, scheme: env.VH_PLUGIN_HOST_SCHEME?.trim().toLowerCase() === 'http' ? 'http' : 'https' };
}

/** `<label>.<host>` → label, for a request `Host` header; null when the host is not a plugin origin. */
export function pluginLabelOfHost(hostHeader: string | undefined, config: PluginHostConfig | null): string | null {
    if (!config || !hostHeader) return null;
    const host = hostHeader.trim().toLowerCase();
    const suffix = `.${config.host}`;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(label) ? label : null;
}

export function pluginOrigin(label: string, config: PluginHostConfig): string {
    return `${config.scheme}://${label}.${config.host}`;
}

function originOf(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
    } catch {
        return null;
    }
}

/** Origins allowed to frame a panel; `ticketOrigin` (the Web page that asked for the ticket) is the fallback. */
export function pluginFrameAncestors(ticketOrigin: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
    const configured = list(env.VH_PLUGIN_WEB_ORIGINS).map(originOf).filter((o): o is string => !!o);
    if (configured.length > 0) return configured;
    const pub = env.PUBLIC_URL ? originOf(env.PUBLIC_URL) : null;
    if (pub) return [pub];
    const fromTicket = ticketOrigin ? originOf(ticketOrigin) : null;
    return fromTicket ? [fromTicket] : [];
}
