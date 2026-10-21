/**
 * B-510: machine web panels as mirrored in `daemonState.webPanels` (declared
 * only in the machine's local settings.json; the web never writes them).
 * Re-validated here — daemonState is the relay's copy, and a panel URL is
 * something this browser will load.
 */
export interface MachineWebPanel {
    id: string;
    title: string;
    url: string;
    embed: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function safeUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    try {
        const url = new URL(raw);
        if (url.username || url.password) return null;
        if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url.href;
    } catch { /* invalid */ }
    return null;
}

export function parseWebPanels(daemonState: unknown): MachineWebPanel[] {
    const raw = (daemonState as { webPanels?: { panels?: unknown } } | null | undefined)?.webPanels?.panels;
    if (!Array.isArray(raw)) return [];
    const out: MachineWebPanel[] = [];
    for (const entry of raw) {
        const e = (entry ?? {}) as Record<string, unknown>;
        const url = safeUrl(e.url);
        if (typeof e.id !== 'string' || !ID_RE.test(e.id) || !url || out.some((p) => p.id === e.id)) continue;
        out.push({ id: e.id, title: typeof e.title === 'string' && e.title.trim() ? e.title.trim().slice(0, 40) : e.id, url, embed: e.embed !== false });
        if (out.length >= 8) break;
    }
    return out;
}

/**
 * How the web can show a panel, in the spec's order: the machine said it
 * cannot be framed → link only; an https page cannot frame plain http (mixed
 * content) unless it is loopback on this very device → link only with a reason;
 * otherwise embed (and a load timeout still offers the link).
 */
export type PanelFrameMode = 'embed' | 'link-only' | 'mixed-content';

export function panelFrameMode(panel: Pick<MachineWebPanel, 'url' | 'embed'>, pageProtocol: string): PanelFrameMode {
    if (!panel.embed) return 'link-only';
    const url = new URL(panel.url);
    if (pageProtocol === 'https:' && url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return 'mixed-content';
    return 'embed';
}

export function machinePanelPath(machineId: string, panelId: string): string {
    return `/machine/${encodeURIComponent(machineId)}/panel/${encodeURIComponent(panelId)}`;
}
