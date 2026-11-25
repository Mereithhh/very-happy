/**
 * B-974c: `very-happy plugin …` (DESIGN §2.2). Logic lives in
 * `@/plugins/cli`; this file parses arguments and prints.
 */
import chalk from 'chalk';
import { readFile, stat } from 'node:fs/promises';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay } from '@/persistence';
import { PluginStore, effectiveState } from '@/plugins/store';
import { PluginServerClient } from '@/plugins/serverOp';
import { parseLoopbackUrl, SENSITIVE_PLUGIN_PERMISSIONS } from '@/plugins/manifest';
import { loopbackRequest } from '@/plugins/loopbackHttp';
import { readPluginSecretKey } from '@/plugins/signing';
import { signPluginEvent, verifyPluginEvent } from '@slopus/happy-wire';
import { pingDaemonPlugin, reloadDaemonPlugins } from '@/daemon/controlClient';
import {
    PluginCliError, addPlugin, disablePlugin, enablePlugin, pluginEnv, readManifestSource, removePlugin, rotatePlugin, shellQuote, updatePlugin,
    type PluginServerApi,
} from '@/plugins/cli';

const HELP = `${chalk.bold('very-happy plugin')} — Web plugins installed on this machine

  very-happy plugin add <path|http://127.0.0.1:PORT/.well-known/vh-plugin.json> [--json]
  very-happy plugin list [--json]
  very-happy plugin show <id> [--json]
  very-happy plugin update <id> [--manifest <path|url>] [--json]
  very-happy plugin enable <id>
  very-happy plugin disable <id> [--reason <text>]
  very-happy plugin remove <id> [--keep-items]
  very-happy plugin env <id> [--shell]
  very-happy plugin doctor <id>
  very-happy plugin rotate <id>
  very-happy plugin badge <id> <count|clear> [--tone attention] [--label <text>]
  very-happy plugin decision <id> post --key K --title T [--option id=label]... [--input] [--notice] [--body-file F]
  very-happy plugin decision <id> close --key K [--outcome done|dropped|superseded]

Each install and every permission is approved by the account owner on the web.`;

type Flags = { positional: string[]; flags: Map<string, string[]>; bools: Set<string> };
const BOOL_FLAGS = new Set(['--json', '--shell', '--keep-items', '--input', '--notice']);

export function parsePluginArgs(args: string[]): Flags {
    const positional: string[] = [];
    const flags = new Map<string, string[]>();
    const bools = new Set<string>();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (BOOL_FLAGS.has(a)) { bools.add(a); continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq > 0 ? a.slice(0, eq) : a;
            const value = eq > 0 ? a.slice(eq + 1) : args[++i];
            if (value === undefined) throw new PluginCliError('invalid_request', `missing value after ${name}`);
            flags.set(name, [...(flags.get(name) ?? []), value]);
            continue;
        }
        positional.push(a);
    }
    return { positional, flags, bools };
}

const one = (f: Flags, name: string) => f.flags.get(name)?.at(-1);

async function serverApi(): Promise<PluginServerApi> {
    const credentials = await readCredentialsForConfiguredRelay();
    if (!credentials) throw new PluginCliError('not_authenticated', 'Not authenticated on this machine. Run "very-happy auth login" first.');
    return new PluginServerClient(configuration.serverUrl, credentials.token, configuration.currentCliVersion);
}

async function reloadDaemon(): Promise<Awaited<ReturnType<typeof reloadDaemonPlugins>>> {
    try { return await reloadDaemonPlugins(); } catch { return null; }
}

function store(): PluginStore { return new PluginStore(configuration.happyHomeDir); }

function out(json: boolean, value: unknown, human: () => void): void {
    if (json) console.log(JSON.stringify(value, null, 2)); else human();
}

function requireId(f: Flags, usage: string): string {
    const id = f.positional[1];
    if (!id) throw new PluginCliError('invalid_request', `usage: very-happy plugin ${usage}`);
    return id;
}

async function callPluginApi(s: PluginStore, id: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const env = pluginEnv(s, id);
    const token = s.readToken(id);
    if (!token) throw new PluginCliError('plugin_pending', `plugin "${id}" has no token yet (approve it on the web first)`);
    const api = env.VH_PLUGIN_API ? parseLoopbackUrl(env.VH_PLUGIN_API.replace(/\/plugin\/v1$/, ''), false) : null;
    if (!api) throw new PluginCliError('daemon_not_running', 'the daemon has not published the plugin API yet (is "very-happy daemon" running?)');
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const res = await loopbackRequest({ host: api.host, port: api.port }, {
        method,
        path: `/plugin/v1${path}`,
        headers: { host: `127.0.0.1:${api.port}`, authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
        body: payload,
        timeoutMs: 15_000,
    }).catch((error) => { throw new PluginCliError('daemon_not_running', `cannot reach the daemon: ${(error as Error).message}`); });
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    let parsed: unknown = null;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
    return { status: res.status, body: parsed };
}

function printApiResult(r: { status: number; body: any }, json: boolean): void {
    if (json) { console.log(JSON.stringify(r.body, null, 2)); }
    else if (r.status < 300) console.log(chalk.green('OK'), r.status === 201 ? '(created)' : '');
    else if (r.status === 503 && r.body?.queued) console.log(chalk.yellow('Queued: the daemon is offline and will send it on reconnect.'));
    else console.error(chalk.red(`${r.body?.error ?? `HTTP ${r.status}`}`), r.body?.message ?? '');
    if (r.status >= 300 && !(r.status === 503 && r.body?.queued)) process.exitCode = 1;
}

async function modeOf(path: string): Promise<string> {
    const info = await stat(path).catch(() => null);
    return info ? (info.mode & 0o777).toString(8).padStart(3, '0') : 'missing';
}

export async function handlePluginCommand(args: string[]): Promise<void> {
    let f: Flags;
    try { f = parsePluginArgs(args); } catch (error) { console.error((error as Error).message); process.exitCode = 1; return; }
    const action = f.positional[0];
    const json = f.bools.has('--json');
    try {
        switch (action) {
            case 'add': {
                const src = f.positional[1];
                if (!src) throw new PluginCliError('invalid_request', 'usage: very-happy plugin add <path|http://127.0.0.1:PORT/...>');
                const source = await readManifestSource(src);
                const result = await addPlugin(store(), await serverApi(), source);
                await reloadDaemon();
                out(json, result, () => {
                    for (const w of result.warnings) console.log(chalk.yellow(`warning: ${w}`));
                    console.log(`${chalk.bold(result.id)} registered (${result.state}), install ${result.installId}`);
                    if (result.reviewUrl) console.log(`Approve it on the web: ${result.reviewUrl}`);
                    console.log(chalk.gray('No token or secret is written until it is approved.'));
                });
                return;
            }
            case 'list': {
                const s = store();
                const live = await reloadDaemon();
                const rows = s.listIds().map((id) => {
                    const r = s.readInstall(id);
                    const d = live?.find((x) => x.id === id);
                    return { id, installId: r?.installId ?? null, state: r ? effectiveState(r) : 'broken', grants: r?.grants ?? [], pendingChange: s.readPending(id) !== null && r?.approvedManifestHash != null, queued: d?.queued ?? null, pendingEvents: d?.pendingEvents ?? null };
                });
                out(json, { plugins: rows, daemon: live !== null }, () => {
                    if (rows.length === 0) { console.log('No plugins installed. Add one with "very-happy plugin add <manifest>".'); return; }
                    for (const r of rows) console.log(`${chalk.bold(r.id.padEnd(20))} ${r.state.padEnd(20)} ${r.grants.join(',') || '-'}${r.pendingChange ? chalk.yellow('  (change waiting for approval)') : ''}${r.queued ? chalk.yellow(`  ${r.queued} queued`) : ''}`);
                    if (live === null) console.log(chalk.gray('daemon not running — showing local state only'));
                });
                return;
            }
            case 'show': {
                const id = requireId(f, 'show <id>');
                const s = store();
                const r = s.readInstall(id);
                if (!r) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
                const approved = s.readApprovedManifest(id);
                const pending = s.readPending(id);
                const value = { ...r, state: effectiveState(r), manifest: approved, pending: pending ? { manifestHash: pending.manifestHash, manifest: pending.manifest } : null, dir: s.dir(id) };
                out(json, value, () => {
                    console.log(`${chalk.bold(approved?.name ?? pending?.manifest.name ?? id)} (${id})  ${effectiveState(r)}`);
                    console.log(`install    ${r.installId}`);
                    console.log(`grants     ${r.grants.join(', ') || '-'}`);
                    if (r.localDisabled) console.log(`disabled   on this machine${r.localDisabledReason ? `: ${r.localDisabledReason}` : ''}`);
                    if (approved) {
                        for (const p of approved.panels ?? []) console.log(`panel      ${p.id} → ${p.upstream}`);
                        if (approved.callback) console.log(`callback   ${approved.callback.url}`);
                    }
                    if (pending) {
                        console.log(chalk.yellow(`pending    ${pending.manifest.version} (hash ${pending.manifestHash.slice(0, 8)}) waiting for approval`));
                        const sensitive = pending.manifest.permissions.filter((p) => SENSITIVE_PLUGIN_PERMISSIONS.includes(p));
                        if (sensitive.length) console.log(chalk.red(`sensitive  ${sensitive.join(', ')}`));
                    }
                    if (r.reviewUrl && (pending || r.state === 'pending')) console.log(`review     ${r.reviewUrl}`);
                    console.log(`dir        ${s.dir(id)}`);
                });
                return;
            }
            case 'update': {
                const id = requireId(f, 'update <id> [--manifest <path|url>]');
                const s = store();
                const r = s.readInstall(id);
                if (!r) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
                const src = one(f, '--manifest') ?? r.source;
                if (!src) throw new PluginCliError('invalid_request', 'no manifest source recorded; pass --manifest <path|url>');
                const result = await updatePlugin(s, await serverApi(), id, await readManifestSource(src));
                await reloadDaemon();
                out(json, result, () => {
                    for (const w of result.warnings) console.log(chalk.yellow(`warning: ${w}`));
                    if (result.needsApproval) {
                        console.log(`${id}: the change needs approval (${result.state}); the current approval keeps working until then.`);
                        if (result.reviewUrl) console.log(`Review: ${result.reviewUrl}`);
                    } else console.log(`${id}: updated (${result.state}).`);
                });
                return;
            }
            case 'enable': {
                const id = requireId(f, 'enable <id>');
                const r = enablePlugin(store(), id);
                await reloadDaemon();
                console.log(`${id}: enabled on this machine (${effectiveState(r)}).`);
                if (r.state === 'disabled') console.log(chalk.yellow('It is still disabled in the account — turn it back on in Settings → Plugins on the web.'));
                return;
            }
            case 'disable': {
                const id = requireId(f, 'disable <id> [--reason <text>]');
                const result = await disablePlugin(store(), await serverApi().catch(() => offlineServer()), id, one(f, '--reason'));
                await reloadDaemon();
                console.log(`${id}: disabled on this machine.`);
                if (!result.serverNotified) console.log(chalk.yellow(`The server was not told (${result.serverError}); this machine refuses the plugin anyway.`));
                return;
            }
            case 'remove': {
                const id = requireId(f, 'remove <id> [--keep-items]');
                const result = await removePlugin(store(), await serverApi().catch(() => offlineServer()), id, f.bools.has('--keep-items'));
                await reloadDaemon();
                console.log(`${id}: removed (credentials deleted).`);
                if (!result.serverNotified) console.log(chalk.yellow(`The server was not told (${result.serverError}); remove it in Settings → Plugins on the web as well.`));
                return;
            }
            case 'env': {
                const id = requireId(f, 'env <id> [--shell]');
                const env = pluginEnv(store(), id);
                for (const [k, v] of Object.entries(env)) console.log(f.bools.has('--shell') ? `export ${k}=${shellQuote(v)}` : `${k}=${v}`);
                return;
            }
            case 'rotate': {
                const id = requireId(f, 'rotate <id>');
                rotatePlugin(store(), id);
                await reloadDaemon();
                console.log(`${id}: token and secret replaced; the old ones no longer work. Restart the plugin so it reads the new files.`);
                return;
            }
            case 'doctor': {
                await doctor(requireId(f, 'doctor <id>'));
                return;
            }
            case 'badge': {
                const id = requireId(f, 'badge <id> <count|clear>');
                const v = f.positional[2];
                if (v === undefined || (v !== 'clear' && !/^\d{1,4}$/.test(v))) throw new PluginCliError('invalid_request', 'usage: very-happy plugin badge <id> <count 0..9999|clear> [--tone attention] [--label <text>]');
                const tone = one(f, '--tone');
                const label = one(f, '--label');
                printApiResult(await callPluginApi(store(), id, 'PUT', '/badge', { count: v === 'clear' ? null : Number(v), ...(tone ? { tone } : {}), ...(label ? { label } : {}) }), json);
                return;
            }
            case 'decision': {
                const id = requireId(f, 'decision <id> post|close --key K …');
                const verb = f.positional[2];
                const key = one(f, '--key');
                if (!key) throw new PluginCliError('invalid_request', '--key is required');
                if (verb === 'close') {
                    const outcome = one(f, '--outcome');
                    printApiResult(await callPluginApi(store(), id, 'DELETE', `/decisions/${encodeURIComponent(key)}`, outcome ? { outcome } : {}), json);
                    return;
                }
                if (verb !== 'post') throw new PluginCliError('invalid_request', 'usage: very-happy plugin decision <id> post|close …');
                const title = one(f, '--title');
                if (!title) throw new PluginCliError('invalid_request', '--title is required');
                const options = (f.flags.get('--option') ?? []).map((o) => {
                    const eq = o.indexOf('=');
                    if (eq <= 0) throw new PluginCliError('invalid_request', `--option must be id=label (got "${o}")`);
                    return { id: o.slice(0, eq), label: o.slice(eq + 1) };
                });
                const bodyFile = one(f, '--body-file');
                const kind = f.bools.has('--input') ? 'input' : f.bools.has('--notice') || options.length === 0 ? 'notice' : 'choice';
                const body = {
                    key, kind, title,
                    ...(bodyFile ? { bodyMd: await readFile(bodyFile, 'utf8') } : {}),
                    ...(kind === 'choice' ? { options } : {}),
                    ...(kind === 'input' ? { input: {} } : {}),
                };
                printApiResult(await callPluginApi(store(), id, 'POST', '/decisions', body), json);
                return;
            }
            default:
                console.log(HELP);
                if (action && action !== 'help' && action !== '--help') process.exitCode = 1;
        }
    } catch (error) {
        if (error instanceof PluginCliError) {
            if (json) console.log(JSON.stringify({ error: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) }, null, 2));
            else {
                console.error(chalk.red(`${error.code}:`), error.message);
                for (const issue of error.issues ?? []) console.error(`  - ${issue}`);
            }
            process.exitCode = 1;
            return;
        }
        throw error;
    }
}

function offlineServer(): PluginServerApi {
    const fail = async () => { throw new Error('not authenticated on this machine'); };
    return { submitManifest: fail, disable: fail, remove: fail };
}

async function doctor(id: string): Promise<void> {
    const s = store();
    const r = s.readInstall(id);
    if (!r) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    const manifest = s.readApprovedManifest(id);
    let problems = 0;
    const line = (ok: boolean | null, label: string, detail: string) => {
        if (ok === false) problems++;
        console.log(`${ok === null ? chalk.gray('·') : ok ? chalk.green('✓') : chalk.red('✗')} ${label.padEnd(14)} ${detail}`);
    };
    line(effectiveState(r) === 'enabled', 'state', `${effectiveState(r)}; grants: ${r.grants.join(', ') || '-'}`);
    line(await modeOf(s.dir(id)) === '700' || process.platform === 'win32', 'directory', `${s.dir(id)} (${await modeOf(s.dir(id))})`);
    for (const file of [s.tokenFile(id), s.secretFile(id)]) {
        const mode = await modeOf(file);
        line(mode === 'missing' ? (manifest ? false : null) : mode === '600' || process.platform === 'win32', file.endsWith('token') ? 'token' : 'secret', mode === 'missing' ? (manifest ? 'missing — run "very-happy plugin rotate"' : 'not created until approval') : `${file} (${mode})`);
    }
    if (!manifest) { console.log(chalk.gray('No approved manifest yet; approve it on the web, then run doctor again.')); return; }
    for (const panel of manifest.panels ?? []) {
        const url = parseLoopbackUrl(panel.upstream, false)!;
        try {
            const res = await loopbackRequest({ host: url.host, port: url.port }, { method: 'GET', path: panel.entry ?? '/', headers: { host: url.host === '::1' ? `[::1]:${url.port}` : `127.0.0.1:${url.port}` }, timeoutMs: 5_000 });
            res.body.destroy();
            line(res.status < 500, `panel ${panel.id}`, `${panel.upstream}${panel.entry ?? '/'} → HTTP ${res.status}`);
        } catch (error) {
            line(false, `panel ${panel.id}`, `${panel.upstream} unreachable (${(error as Error).message})`);
        }
    }
    const secretText = s.readSecret(id);
    if (secretText) {
        const key = readPluginSecretKey(secretText);
        if (!key) line(false, 'hmac', 'secret file is not 43 base64url characters (run "very-happy plugin rotate")');
        else {
            const ts = Math.floor(Date.now() / 1000);
            const sig = signPluginEvent(key, ts, 'evt_selftest', '{}');
            const ok = verifyPluginEvent({ secret: key, signature: sig, timestamp: ts, eventId: 'evt_selftest', rawBody: '{}', nowSec: ts }).ok
                && !verifyPluginEvent({ secret: key, signature: sig, timestamp: ts, eventId: 'evt_selftest', rawBody: '{ }', nowSec: ts }).ok;
            line(ok, 'hmac', 'sign/verify self-test with the decoded 32-byte key');
        }
    }
    if (manifest.callback) {
        const ping = await pingDaemonPlugin(id);
        line(ping.status !== null && ping.status >= 200 && ping.status < 300, 'callback', `${manifest.callback.url} → ${ping.status !== null ? `HTTP ${ping.status} to a signed ping` : ping.error ?? 'no answer'}`);
    } else line(null, 'callback', 'none declared (events only by pull)');
    try {
        const info = await callPluginApi(s, id, 'GET', '/info');
        line(info.status === 200, 'daemon api', info.status === 200 ? `${pluginEnv(s, id).VH_PLUGIN_API} answers (state ${info.body?.state})` : `HTTP ${info.status} ${info.body?.error ?? ''}`);
    } catch (error) {
        line(false, 'daemon api', (error as Error).message);
    }
    if (problems > 0) process.exitCode = 1;
}
