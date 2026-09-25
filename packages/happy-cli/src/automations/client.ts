/**
 * B-496 Automations REST client, shared by `very-happy auto`, the daemon
 * runner and the `automation_*` MCP tools. Account-authenticated only: there
 * is no scoped credential (the Owner explicitly kept the account trust level).
 *
 * Errors never carry HTTP bodies verbatim (they could echo credentials);
 * `AutomationsRequestError.code` is the server's `{ error }` code when present.
 * An old server (no automations routes) or a disabled gate both answer 404
 * with a code that is not an `*_not_found` lookup miss — `isAutomationsUnavailable`
 * tells "feature absent" from "that name does not exist".
 */

import type {
    Automation, AutomationClaim, AutomationClaimResponse, AutomationCreate, AutomationFire, AutomationFireResponse,
    AutomationManualRun, AutomationReport, AutomationRun, AutomationSticky, AutomationUpdate,
} from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay, readSettings } from '@/persistence';

export class AutomationsRequestError extends Error {
    constructor(readonly status: number, readonly code: string, readonly runStatus?: string) {
        super(describeAutomationError(status, code, runStatus));
    }
}

/** True when the server has no automations at all (old server or gate off), not a lookup miss. */
export function isAutomationsUnavailable(error: unknown): boolean {
    return error instanceof AutomationsRequestError && error.status === 404 && !error.code.endsWith('_not_found');
}

export const AUTOMATIONS_UNAVAILABLE_MESSAGE = 'Automations are not enabled on this server (set VH_AUTOMATIONS_ENABLED=true on the server, or upgrade it).';

function describeAutomationError(status: number, code: string, runStatus?: string): string {
    if (status === 404 && !code.endsWith('_not_found')) return AUTOMATIONS_UNAVAILABLE_MESSAGE;
    const known: Record<string, string> = {
        automation_not_found: 'No automation with that name or id.',
        run_not_found: 'No automation run with that id.',
        machine_not_found: 'That machine is not registered on this account.',
        session_not_found: 'That session does not belong to this account.',
        automation_name_taken: 'An automation with that name already exists.',
        automation_paused: 'That automation is paused; resume it before firing.',
        stale_automation: 'The automation changed since you read it; read it again and retry with the new version.',
        run_finished: `The run already reached a terminal state${runStatus ? ` (${runStatus})` : ''}.`,
        claim_mismatch: 'Another daemon holds the claim for that run.',
        invalid_cron: 'The cron expression is invalid.',
        invalid_timezone: 'The time zone is not a valid IANA zone.',
    };
    return known[code] ?? `Automations request failed (HTTP ${status}${code ? `, ${code}` : ''}).`;
}

export interface AutomationsClientOptions {
    serverUrl: string;
    token: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    client?: string;
}

export function createAutomationsClient(options: AutomationsClientOptions) {
    const doFetch = options.fetch ?? fetch;
    const base = options.serverUrl.replace(/\/+$/, '');
    async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
        const url = new URL(`${base}${path}`);
        for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
        let response: Response;
        try {
            response = await doFetch(url.toString(), {
                method, redirect: 'error',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}`, 'x-happy-client': `${options.client ?? 'cli-auto'}/${configuration.currentCliVersion}` },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
            });
        } catch {
            throw new Error('Automations connection failed; the outcome may be unknown. Read the current state before retrying.');
        }
        let parsed: any = null;
        try { parsed = await response.json(); } catch { parsed = null; }
        if (!response.ok) {
            const code = typeof parsed?.error === 'string' ? parsed.error : '';
            throw new AutomationsRequestError(response.status, code, typeof parsed?.status === 'string' ? parsed.status : undefined);
        }
        return parsed as T;
    }
    const enc = encodeURIComponent;
    return {
        list: (machineId?: string) => request<{ automations: Automation[] }>('GET', '/v1/automations', undefined, { machineId }).then(r => r.automations),
        get: (id: string) => request<{ automation: Automation }>('GET', `/v1/automations/${enc(id)}`).then(r => r.automation),
        getByName: (name: string) => request<{ automation: Automation }>('GET', `/v1/automations/by-name/${enc(name)}`).then(r => r.automation),
        create: (input: AutomationCreate) => request<{ automation: Automation }>('POST', '/v1/automations', input).then(r => r.automation),
        update: (id: string, input: AutomationUpdate) => request<{ automation: Automation }>('PATCH', `/v1/automations/${enc(id)}`, input).then(r => r.automation),
        remove: (id: string) => request<{ ok: boolean }>('DELETE', `/v1/automations/${enc(id)}`),
        pause: (id: string) => request<{ automation: Automation }>('POST', `/v1/automations/${enc(id)}/pause`).then(r => r.automation),
        resume: (id: string) => request<{ automation: Automation }>('POST', `/v1/automations/${enc(id)}/resume`).then(r => r.automation),
        run: (id: string, input: AutomationManualRun = {}) => request<{ run: AutomationRun }>('POST', `/v1/automations/${enc(id)}/run`, input).then(r => r.run),
        fire: (name: string, input: AutomationFire = {}) => request<AutomationFireResponse>('POST', `/v1/automations/by-name/${enc(name)}/fire`, input),
        runs: (query: { automationId?: string; name?: string; status?: string; attention?: boolean; limit?: number } = {}) =>
            request<{ runs: AutomationRun[] }>('GET', '/v1/automations/runs', undefined, {
                automationId: query.automationId, name: query.name, status: query.status,
                attention: query.attention ? '1' : undefined, limit: query.limit === undefined ? undefined : String(query.limit),
            }).then(r => r.runs),
        getRun: (id: string) => request<{ run: AutomationRun }>('GET', `/v1/automations/runs/${enc(id)}`).then(r => r.run),
        cancel: (id: string) => request<{ run: AutomationRun }>('POST', `/v1/automations/runs/${enc(id)}/cancel`).then(r => r.run),
        ack: (id: string) => request<{ run: AutomationRun }>('POST', `/v1/automations/runs/${enc(id)}/ack`).then(r => r.run),
        report: (id: string, input: AutomationReport) => request<{ run: AutomationRun }>('POST', `/v1/automations/runs/${enc(id)}/report`, input).then(r => r.run),
        claim: (input: AutomationClaim) => request<AutomationClaimResponse>('POST', '/v1/automations/claim', input),
        stickies: (id: string, key?: string) => request<{ stickies: AutomationSticky[] }>('GET', `/v1/automations/${enc(id)}/stickies`, undefined, { key }).then(r => r.stickies),
        putSticky: (id: string, key: string, sessionId: string) => request<{ sticky: AutomationSticky }>('PUT', `/v1/automations/${enc(id)}/stickies`, { key, sessionId }).then(r => r.sticky),
        deleteSticky: (id: string, key: string) => request<{ removed: boolean }>('DELETE', `/v1/automations/${enc(id)}/stickies`, { key }).then(r => r.removed),
    };
}
export type AutomationsClient = ReturnType<typeof createAutomationsClient>;

/**
 * Account client for the current relay login. `machineId` is this machine's
 * registration — the CLI default target and what `automation_*` tools use
 * when the caller does not name a machine.
 */
export async function authenticatedAutomationsClient(client = 'cli-auto'): Promise<{ client: AutomationsClient; machineId: string | undefined }> {
    const credentials = await readCredentialsForConfiguredRelay();
    if (!credentials) throw new Error('Not authenticated. Run `very-happy auth login` first.');
    const settings = await readSettings();
    return { client: createAutomationsClient({ serverUrl: configuration.serverUrl, token: credentials.token, client }), machineId: settings.machineId };
}

/**
 * Report from inside an automation run (agent or script) — the run id comes
 * from `VH_AUTOMATION_RUN_ID` when the caller omits it. A run reported by its
 * own session has no claimId (the daemon holds it), so the server accepts an
 * account-authenticated `self` report: same account, same run.
 */
export function automationRunIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const value = env.VH_AUTOMATION_RUN_ID;
    return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
