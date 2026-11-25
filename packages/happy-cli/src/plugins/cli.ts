/**
 * B-974c: what `very-happy plugin …` does, with its I/O injected so tests can
 * drive it against a temp HAPPY_HOME_DIR and a mock server.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLoopbackUrl, parsePluginManifest, privilegedHash, manifestHash, PLUGIN_MANIFEST_MAX_BYTES, type PluginManifest } from './manifest';
import { PluginStore, applyServerInstall, effectiveState, SERVER_INSTALL_STATES, type InstallRecord, type ServerInstallState } from './store';
import { PluginServerError, type ServerInstallReply } from './serverOp';
import { loopbackRequest, readBody } from './loopbackHttp';

export class PluginCliError extends Error {
    constructor(readonly code: string, message: string, readonly issues?: string[]) { super(message); }
}

export type PluginServerApi = {
    submitManifest(manifest: unknown): Promise<ServerInstallReply>;
    disable(installId: string, reason?: string): Promise<unknown>;
    remove(installId: string, keepItems: boolean): Promise<unknown>;
};

/**
 * Read a manifest from a local file or a loopback URL — never from anywhere
 * else (§2.2). URLs must be `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…`;
 * redirects are not followed.
 */
export async function readManifestSource(source: string, cwd = process.cwd()): Promise<{ text: string; source: string }> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
        const url = parseLoopbackUrl(source, true);
        if (!url) throw new PluginCliError('invalid_source', 'only a local file or http://127.0.0.1:<port>/… / http://[::1]:<port>/… is accepted (no downloads from the internet)');
        let res;
        try {
            res = await loopbackRequest({ host: url.host, port: url.port }, { method: 'GET', path: url.path, headers: { host: url.host === '::1' ? `[::1]:${url.port}` : `127.0.0.1:${url.port}`, accept: 'application/json' }, timeoutMs: 8_000 });
        } catch (error) {
            throw new PluginCliError('source_unreachable', `cannot fetch ${source}: ${(error as Error).message}`);
        }
        if (res.status !== 200) { res.body.destroy(); throw new PluginCliError('source_unreachable', `${source} answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`); }
        try {
            return { text: (await readBody(res.body, PLUGIN_MANIFEST_MAX_BYTES + 1)).toString('utf8'), source };
        } catch {
            throw new PluginCliError('payload_too_large', `manifest is larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes`);
        }
    }
    const path = resolve(cwd, source);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new PluginCliError('invalid_source', `no such file: ${path}`);
    if (info.size > PLUGIN_MANIFEST_MAX_BYTES) throw new PluginCliError('payload_too_large', `manifest is larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes`);
    return { text: await readFile(path, 'utf8'), source: path };
}

function parseOrThrow(text: string): { manifest: PluginManifest; warnings: string[] } {
    const parsed = parsePluginManifest(text);
    if (!parsed.ok) throw new PluginCliError(parsed.code, parsed.message, parsed.issues);
    return { manifest: parsed.manifest, warnings: parsed.warnings };
}

function replyState(reply: ServerInstallReply): ServerInstallState {
    return (SERVER_INSTALL_STATES as readonly string[]).includes(reply.state) ? reply.state as ServerInstallState : 'pending';
}

async function submit(server: PluginServerApi, manifest: PluginManifest): Promise<ServerInstallReply> {
    try {
        const reply = await server.submitManifest(manifest);
        if (!reply || typeof reply.installId !== 'string' || reply.installId.length === 0) throw new PluginCliError('invalid_server_reply', 'the server did not return an installId');
        return reply;
    } catch (error) {
        if (error instanceof PluginServerError) throw new PluginCliError(error.code, error.message);
        throw error;
    }
}

export type AddResult = { id: string; installId: string; state: string; reviewUrl: string | null; manifestHash: string; warnings: string[] };

/** `plugin add`: validate, register as pending on the server, keep the manifest as pending.json. No token/secret yet. */
export async function addPlugin(store: PluginStore, server: PluginServerApi, src: { text: string; source: string }): Promise<AddResult> {
    const { manifest, warnings } = parseOrThrow(src.text);
    const existing = store.readInstall(manifest.id);
    // r2: a rejected (or account-removed) install may be submitted again; the server decides the new state.
    if (existing && existing.state !== 'rejected' && existing.state !== 'removed') {
        throw new PluginCliError('already_installed', `plugin "${manifest.id}" is already installed on this machine (${existing.state}); use "very-happy plugin update ${manifest.id}"`);
    }
    // Server first: a refusal (incl. server_too_old) leaves no local state.
    const reply = await submit(server, manifest);
    // A new installId (remove → add, or a removed install) starts over locally: no old credentials carry over.
    if (existing && existing.installId !== reply.installId) store.remove(manifest.id);
    const pending = store.writePending(manifest.id, manifest);
    store.writeInstall(manifest.id, {
        installId: reply.installId,
        pluginId: manifest.id,
        state: 'pending',
        grants: [],
        approvedManifestHash: null,
        ...(reply.reviewUrl ? { reviewUrl: reply.reviewUrl } : {}),
        source: src.source,
        updatedAt: Date.now(),
    });
    const { record } = applyServerInstall(store, manifest.id, { installId: reply.installId, state: replyState(reply), grants: [], manifestHash: reply.manifestHash ?? null });
    return { id: manifest.id, installId: reply.installId, state: effectiveState(record), reviewUrl: reply.reviewUrl ?? null, manifestHash: pending.manifestHash, warnings };
}

export type UpdateResult = AddResult & { needsApproval: boolean; privilegedChanged: boolean };

/** `plugin update`: privileged change → update_pending (old approval keeps working); otherwise applies at once (§3.3). */
export async function updatePlugin(store: PluginStore, server: PluginServerApi, id: string, src: { text: string; source: string }): Promise<UpdateResult> {
    const current = store.readInstall(id);
    if (!current) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    const { manifest, warnings } = parseOrThrow(src.text);
    if (manifest.id !== id) throw new PluginCliError('invalid_manifest', `manifest id "${manifest.id}" does not match "${id}"`);
    const approved = store.readApprovedManifest(id);
    const privilegedChanged = !approved || privilegedHash(approved) !== privilegedHash(manifest);
    const reply = await submit(server, manifest);
    if (reply.installId !== current.installId) throw new PluginCliError('invalid_server_reply', 'the server answered for a different install');
    store.writePending(id, manifest);
    store.writeInstall(id, { ...current, source: src.source, ...(reply.reviewUrl ? { reviewUrl: reply.reviewUrl } : {}), updatedAt: Date.now() });
    const grants = Array.isArray(reply.grants) ? reply.grants as InstallRecord['grants'] : current.grants;
    const { record, promoted } = applyServerInstall(store, id, { installId: current.installId, state: replyState(reply), grants, manifestHash: reply.manifestHash ?? null });
    return { id, installId: current.installId, state: effectiveState(record), reviewUrl: reply.reviewUrl ?? current.reviewUrl ?? null, manifestHash: manifestHash(manifest), warnings, needsApproval: !promoted, privilegedChanged };
}

export async function disablePlugin(store: PluginStore, server: PluginServerApi, id: string, reason?: string): Promise<{ serverNotified: boolean; serverError?: string }> {
    const current = store.readInstall(id);
    if (!current) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    // Local first: takes effect on this machine even when the server is unreachable.
    store.writeInstall(id, { ...current, localDisabled: true, ...(reason ? { localDisabledReason: reason.slice(0, 500) } : {}), updatedAt: Date.now() });
    try {
        await server.disable(current.installId, reason);
        return { serverNotified: true };
    } catch (error) {
        return { serverNotified: false, serverError: (error as Error).message };
    }
}

export function enablePlugin(store: PluginStore, id: string): InstallRecord {
    const current = store.readInstall(id);
    if (!current) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    const { localDisabled: _d, localDisabledReason: _r, ...rest } = current;
    const next = { ...rest, updatedAt: Date.now() };
    store.writeInstall(id, next);
    return next;
}

export async function removePlugin(store: PluginStore, server: PluginServerApi, id: string, keepItems: boolean): Promise<{ serverNotified: boolean; serverError?: string }> {
    const current = store.readInstall(id);
    if (!current) {
        if (store.listIds().includes(id)) { store.remove(id); return { serverNotified: false, serverError: 'no install record' }; }
        throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    }
    let outcome: { serverNotified: boolean; serverError?: string };
    try {
        await server.remove(current.installId, keepItems);
        outcome = { serverNotified: true };
    } catch (error) {
        outcome = { serverNotified: false, serverError: (error as Error).message };
    }
    store.remove(id);
    return outcome;
}

export function rotatePlugin(store: PluginStore, id: string): void {
    const current = store.readInstall(id);
    if (!current) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    if (!current.approvedManifestHash || !store.readToken(id)) throw new PluginCliError('plugin_pending', `plugin "${id}" has no credentials yet (it is not approved)`);
    store.rotateCredentials(id);
}

export function pluginEnv(store: PluginStore, id: string): Record<string, string> {
    const current = store.readInstall(id);
    if (!current) throw new PluginCliError('not_found', `plugin "${id}" is not installed`);
    const runtime = store.readFileJson(id, 'runtime.json') as { api?: unknown } | null;
    return {
        VH_PLUGIN_API: typeof runtime?.api === 'string' ? runtime.api : '',
        VH_PLUGIN_TOKEN_FILE: store.tokenFile(id),
        VH_PLUGIN_SECRET_FILE: store.secretFile(id),
    };
}

/** POSIX single-quote a value for `--shell`. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
