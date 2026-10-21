/**
 * B-510: `very-happy panels list|check` and `very-happy attention`.
 * Spec: specs/2026-09-machine-web-panels.md.
 */
import axios from 'axios';
import chalk from 'chalk';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay, readSettings } from '@/persistence';
import { normalizeWebPanels, webPanelPath, type WebPanel } from '@/webPanels/webPanels';

/**
 * Can the web embed this page? Reads the two headers that forbid framing:
 * `X-Frame-Options: DENY|SAMEORIGIN` and CSP `frame-ancestors` (anything other
 * than `*` will not include veryhappy.dev unless it names it explicitly).
 */
export function frameVerdict(headers: Record<string, string | undefined>): { embeddable: boolean; reason?: string } {
    const xfo = headers['x-frame-options']?.trim().toUpperCase();
    if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return { embeddable: false, reason: `X-Frame-Options: ${xfo}` };
    const csp = headers['content-security-policy'] ?? '';
    const fa = csp.split(';').map((d) => d.trim()).find((d) => d.toLowerCase().startsWith('frame-ancestors'));
    if (fa) {
        const sources = fa.split(/\s+/).slice(1);
        if (!sources.includes('*') && !sources.some((s) => /veryhappy\.dev/.test(s))) {
            return { embeddable: false, reason: `CSP ${fa}` };
        }
    }
    return { embeddable: true };
}

function printPanels(panels: WebPanel[], problems: { index: number; id?: string; reason: string }[]): void {
    if (panels.length === 0 && problems.length === 0) {
        console.log('No webPanels declared in', configuration.settingsFile);
        console.log(chalk.gray('Add e.g. "webPanels": [{ "id": "desktop", "title": "Desktop", "url": "https://host.example.ts.net:6443/vnc.html" }]'));
        return;
    }
    for (const p of panels) console.log(`${chalk.bold(p.id.padEnd(16))} ${p.title.padEnd(20)} ${p.url}${p.embed ? '' : chalk.gray('  (open in new window)')}`);
    for (const p of problems) console.log(chalk.yellow(`skipped #${p.index}${p.id ? ` (${p.id})` : ''}: ${p.reason}`));
}

export async function handlePanelsCommand(args: string[]): Promise<void> {
    const action = args[0] ?? 'list';
    const { panels, problems } = normalizeWebPanels((await readSettings()).webPanels);
    if (action === 'list') { printPanels(panels, problems); return; }
    if (action !== 'check') {
        console.log(`${chalk.bold('very-happy panels')} — web panels declared in ${configuration.settingsFile}

  very-happy panels list     Show the declared panels (and skipped entries)
  very-happy panels check    Fetch each URL from THIS machine: reachable? embeddable?`);
        return;
    }
    printPanels(panels, problems);
    for (const p of panels) {
        try {
            const res = await axios.get(p.url, { timeout: 8000, maxRedirects: 3, validateStatus: () => true, responseType: 'stream' });
            (res.data as { destroy?: () => void }).destroy?.();
            const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v == null ? undefined : String(v)]));
            const frame = frameVerdict(headers);
            const notes = [
                `HTTP ${res.status}`,
                p.url.startsWith('https:') ? 'https' : chalk.yellow('http (only usable from this machine)'),
                frame.embeddable ? 'embeddable' : chalk.yellow(`not embeddable (${frame.reason}) → set "embed": false`),
            ];
            console.log(`${p.id}: ${notes.join(' · ')}`);
        } catch (error) {
            console.log(chalk.red(`${p.id}: unreachable from this machine (${error instanceof Error ? error.message : String(error)})`));
        }
    }
    console.log(chalk.gray('Reachable here ≠ reachable from your phone: the viewer\'s browser connects to the URL directly (tailnet / tunnel + HTTPS).'));
}

/** `very-happy attention "<reason>" [--panel <id>] [--session <id>]` */
export function parseAttentionArgs(args: string[]): { reason: string; panel?: string; session?: string } | { error: string } {
    let panel: string | undefined;
    let session: string | undefined;
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--panel') panel = args[++i];
        else if (args[i] === '--session') session = args[++i];
        else if (args[i].startsWith('--')) return { error: `unknown option ${args[i]}` };
        else words.push(args[i]);
    }
    const reason = words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!reason) return { error: 'usage: very-happy attention "<reason>" [--panel <id>] [--session <sessionId>]' };
    if ((args.includes('--panel') && !panel) || (args.includes('--session') && !session)) return { error: 'missing value after --panel / --session' };
    return { reason, ...(panel ? { panel } : {}), ...(session ? { session } : {}) };
}

export async function handleAttentionCommand(args: string[]): Promise<void> {
    const parsed = parseAttentionArgs(args);
    if ('error' in parsed) { console.error(parsed.error); process.exitCode = 1; return; }
    const credentials = await readCredentialsForConfiguredRelay();
    const settings = await readSettings();
    if (!credentials || !settings.machineId) { console.error('Not authenticated on this machine. Run "very-happy auth login" first.'); process.exitCode = 1; return; }
    let link: string | undefined;
    if (parsed.panel) {
        const { panels } = normalizeWebPanels(settings.webPanels);
        if (panels.some((p) => p.id === parsed.panel)) link = webPanelPath(settings.machineId, parsed.panel);
        else console.error(chalk.yellow(`panel "${parsed.panel}" is not declared in ${configuration.settingsFile}; the notification will not deep-link`));
    }
    if (parsed.session) {
        const { ApiClient } = await import('@/api/api');
        const api = await ApiClient.create(credentials);
        const r = await api.push().sendAttention({ sessionId: parsed.session, reason: parsed.reason, url: link ?? `/session/${encodeURIComponent(parsed.session)}` });
        if (!r.sent) { console.error(`Failed: ${r.error}`); process.exitCode = 1; return; }
        console.log(r.kind === 'attention' ? 'Sent.' : 'Sent (this server predates "attention"; delivered as a question).');
        return;
    }
    // No session: the account notify channel, as an automatic "needs you" event
    // (devices + the account webhook when subscribed to permission events).
    try {
        const res = await axios.post(`${configuration.serverUrl}/v1/webhook/notify`, {
            title: 'Needs you',
            message: parsed.reason,
            event: 'permission',
            ...(link ? { link } : {}),
        }, {
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json', 'X-Happy-Client': `cli/${configuration.currentCliVersion}` },
            timeout: 15000,
        });
        console.log(res.data?.delivered ? 'Sent (devices + webhook).' : 'Sent to devices (no webhook delivery).');
    } catch (error: any) {
        console.error(`Failed: ${error?.response ? `HTTP ${error.response.status}` : error?.message ?? error}`);
        process.exitCode = 1;
    }
}
