/**
 * B-850a: `very-happy account …` — this machine's accounts (agentProfiles/).
 * Same operations the Web reaches through `agent-profile-*` RPCs; edits land
 * in the files directly and a running daemon republishes them (file watcher).
 */
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { configuration } from '@/configuration';
import { getDaemonAgentProfiles, listDaemonSessions, restartDaemonSession } from '@/daemon/controlClient';
import { AccountError, AccountService, bindResultMessages, localRestartFailure } from '@/agentProfiles/accountService';
import type { AgentProfileSummary } from '@slopus/happy-wire';

export const ACCOUNT_HELP = `Usage:
  very-happy account list [--json]
  very-happy account login --label <name>          Claude subscription (claude setup-token, pick the org in the browser)
  very-happy account login <id>                    sign an existing subscription account in again
  very-happy account login --label <name> --token-stdin   import a token from \`claude setup-token\`
  very-happy account add --label <name> --base-url <url> (--key-file <path> | --key-env <VAR> | --key-stdin) [--model <id>[:<contextWindow>]]...
  very-happy account test <id>
  very-happy account rename <id> <label>
  very-happy account rm <id> [--force]
  very-happy account default <id|machine>          account new Claude sessions on this machine start on
  very-happy account bind <sessionId> <id|machine> [--model <id>] [--no-restart]

Accounts belong to THIS machine: tokens and keys stay in $HAPPY_HOME_DIR
(0600) and are never sent to the server. A session bound to an account that
is missing or expired refuses to run — it never falls back to the machine login.`;

export type AccountArgs =
    | { action: 'help' }
    | { action: 'list'; json: boolean }
    | { action: 'login'; accountId?: string; label?: string; tokenStdin: boolean }
    | { action: 'add'; label: string; baseUrl: string; key: { source: 'file'; path: string } | { source: 'env'; name: string } | { source: 'stdin' }; models: Array<string | { id: string; contextWindow: number }> }
    | { action: 'test'; accountId: string }
    | { action: 'rename'; accountId: string; label: string }
    | { action: 'rm'; accountId: string; force: boolean }
    | { action: 'default'; accountId: string | null }
    | { action: 'bind'; sessionId: string; accountId: string | null; model?: string; restart: boolean };

/** Pure: argv after `account` → action. Throws on malformed input. */
export function parseAccountArgs(args: string[]): AccountArgs {
    const [sub, ...rest] = args;
    if (!sub || sub === '-h' || sub === '--help' || sub === 'help') return { action: 'help' };
    const flags = new Map<string, string[]>();
    const bools = new Set<string>();
    const positional: string[] = [];
    const valued = new Set(['--label', '--base-url', '--key-file', '--key-env', '--model']);
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '-h' || arg === '--help') return { action: 'help' };
        const eq = arg.indexOf('=');
        const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
        if (valued.has(name)) {
            const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : rest[++i];
            if (value === undefined || value === '') throw new Error(`${name} needs a value`);
            flags.set(name, [...(flags.get(name) ?? []), value]);
        } else if (arg.startsWith('--')) bools.add(arg);
        else positional.push(arg);
    }
    const one = (name: string) => flags.get(name)?.at(-1);
    const allowed = (names: string[]) => {
        for (const b of bools) if (!names.includes(b)) throw new Error(`unknown option ${b}`);
        for (const f of flags.keys()) if (!names.includes(f)) throw new Error(`unknown option ${f}`);
    };
    const machineOr = (id: string) => (id === 'machine' || id === 'default' ? null : id);
    switch (sub) {
        case 'list':
        case 'ls':
            allowed(['--json']);
            return { action: 'list', json: bools.has('--json') };
        case 'login':
            allowed(['--label', '--token-stdin']);
            if (positional.length > 1) throw new Error('login takes at most one account id');
            if (!positional[0] && !one('--label')) throw new Error('login needs --label <name> (new account) or an account id (sign in again)');
            return { action: 'login', ...(positional[0] ? { accountId: positional[0] } : {}), ...(one('--label') ? { label: one('--label') } : {}), tokenStdin: bools.has('--token-stdin') };
        case 'add': {
            allowed(['--label', '--base-url', '--key-file', '--key-env', '--key-stdin', '--model']);
            const label = one('--label');
            const baseUrl = one('--base-url');
            if (!label || !baseUrl) throw new Error('add needs --label and --base-url');
            const sources = [one('--key-file') !== undefined, one('--key-env') !== undefined, bools.has('--key-stdin')].filter(Boolean).length;
            if (sources !== 1) throw new Error('add needs exactly one of --key-file, --key-env, --key-stdin');
            const key = one('--key-file') !== undefined
                ? { source: 'file' as const, path: one('--key-file')! }
                : one('--key-env') !== undefined ? { source: 'env' as const, name: one('--key-env')! } : { source: 'stdin' as const };
            const models = (flags.get('--model') ?? []).map((m) => {
                const match = m.match(/^(.+):(\d+)$/);
                return match ? { id: match[1], contextWindow: Number(match[2]) } : m;
            });
            return { action: 'add', label, baseUrl, key, models };
        }
        case 'test':
        case 'rm':
        case 'remove':
            allowed(sub === 'test' ? [] : ['--force']);
            if (positional.length !== 1) throw new Error(`${sub} needs exactly one account id`);
            return sub === 'test' ? { action: 'test', accountId: positional[0] } : { action: 'rm', accountId: positional[0], force: bools.has('--force') };
        case 'rename':
            allowed([]);
            if (positional.length !== 2) throw new Error('rename needs <id> <label>');
            return { action: 'rename', accountId: positional[0], label: positional[1] };
        case 'default':
            allowed([]);
            if (positional.length !== 1) throw new Error('default needs <id|machine>');
            return { action: 'default', accountId: machineOr(positional[0]) };
        case 'bind':
            allowed(['--model', '--no-restart']);
            if (positional.length !== 2) throw new Error('bind needs <sessionId> <id|machine>');
            return { action: 'bind', sessionId: positional[0], accountId: machineOr(positional[1]), ...(one('--model') ? { model: one('--model') } : {}), restart: !bools.has('--no-restart') };
        default:
            throw new Error(`unknown account command "${sub}"`);
    }
}

/** Pure: one line per account for `account list`. */
export function formatAccountLine(a: AgentProfileSummary, isDefault: boolean, now: number): string {
    const kind = a.kind === 'claude-subscription' ? 'subscription' : a.kind === 'claude-api' ? 'api' : a.kind;
    const extra: string[] = [];
    if (a.baseUrl) extra.push(a.baseUrl);
    if (a.models?.length) extra.push(`models: ${a.models.join(', ')}`);
    if (a.keySource === 'file' || a.keySource === 'env') extra.push(`key: ${a.keySource} ${a.keyRef ?? ''}`.trim());
    if (a.expiresAt) extra.push(`expires ${new Date(a.expiresAt).toISOString().slice(0, 10)}${a.expiresAt - now < 30 * 86_400_000 && a.expiresAt > now ? ' (soon)' : ''}`);
    if (a.legacy) extra.push('from providers.json (read-only)');
    if (a.statusDetail) extra.push(a.statusDetail);
    return `${isDefault ? '*' : ' '} ${a.id}  ${a.label}  [${kind}]  ${a.status}${extra.length ? `  — ${extra.join(' · ')}` : ''}`;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
}

async function restartOutcome(sessionId: string) {
    const result = await restartDaemonSession(sessionId);
    if (result.success) return { ok: true as const };
    const error = result.error ?? 'restart failed';
    // The old wrapper still alive = still on the old credential → bind() rolls the binding back.
    const stillRunning = await listDaemonSessions().then((children) => children.some((c) => c?.happySessionId === sessionId), () => false);
    return localRestartFailure(error, stillRunning);
}

async function loginInteractive(target: { accountId?: string; label?: string }): Promise<AgentProfileSummary> {
    const { spawnSetupTokenPty } = await import('@/agentProfiles/daemonAccounts');
    const { homedir } = await import('node:os');
    const svc = new AccountService({ home: configuration.happyHomeDir, spawnPty: (env) => spawnSetupTokenPty(homedir(), env) });
    const started = await svc.loginStart({ agent: 'claude', kind: 'claude-subscription', ...target });
    if (started.state !== 'waiting-code' || !started.url) throw new Error(started.error ?? 'claude setup-token did not print a sign-in URL');
    console.log('Open this link, choose the organization, authorize, then paste the code shown on the page:\n');
    console.log(started.url + '\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let code: string;
    try {
        code = (await rl.question('Code: ')).trim();
    } finally {
        rl.close();
    }
    if (!code) {
        svc.loginCancel(started.loginId);
        throw new Error('no code entered; login canceled');
    }
    svc.loginSubmit({ loginId: started.loginId, code });
    for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const status = svc.loginStatus(started.loginId);
        if (status.state === 'exchanging') continue;
        svc.dispose();
        if (status.state === 'succeeded' && status.account) return status.account;
        throw new Error(status.error ?? `login ${status.state}`);
    }
}

export async function handleAccountCommand(args: string[]): Promise<void> {
    const parsed = parseAccountArgs(args);
    if (parsed.action === 'help') {
        console.log(ACCOUNT_HELP);
        return;
    }
    const service = new AccountService({ home: configuration.happyHomeDir, restartSession: restartOutcome });
    try {
        switch (parsed.action) {
            case 'list': {
                // The daemon's view is the truth: an env-sourced key lives in
                // the DAEMON's environment, not in this shell's.
                const daemonState = await getDaemonAgentProfiles().catch(() => null);
                const state = daemonState ?? service.state();
                if (parsed.json) {
                    console.log(JSON.stringify({ accounts: state.accounts, defaults: state.defaults }, null, 2));
                    return;
                }
                if (state.accounts.length === 0) {
                    console.log('No accounts. Sessions use this machine\'s own Claude login. Add one with `very-happy account login --label <name>`.');
                    return;
                }
                const now = Date.now();
                for (const a of state.accounts) console.log(formatAccountLine(a, state.defaults[a.agent] === a.id, now));
                if (!daemonState && state.accounts.some((a) => a.keySource === 'env')) {
                    console.log(chalk.dim('Daemon not running: --key-env accounts were checked against THIS shell\'s environment; the daemon\'s may differ.'));
                }
                if (!state.defaults.claude) console.log(chalk.dim('New sessions use the machine login (no default account).'));
                return;
            }
            case 'login': {
                const target = { ...(parsed.accountId ? { accountId: parsed.accountId } : {}), ...(parsed.label ? { label: parsed.label } : {}) };
                const account = parsed.tokenStdin
                    ? service.storeSubscriptionToken(await readStdin(), target)
                    : await loginInteractive(target);
                console.log(`Signed in: ${account.id} (${account.label}).`);
                return;
            }
            case 'add': {
                const key = parsed.key.source === 'stdin' ? { source: 'paste' as const, value: await readStdin() } : parsed.key;
                const account = await service.add({ agent: 'claude', kind: 'claude-api', label: parsed.label, baseUrl: parsed.baseUrl, key, ...(parsed.models.length ? { models: parsed.models } : {}) });
                console.log(formatAccountLine(account, false, Date.now()));
                return;
            }
            case 'test': {
                const account = await service.test(parsed.accountId);
                console.log(formatAccountLine(account, false, Date.now()));
                if (account.status !== 'ok') process.exitCode = 1;
                return;
            }
            case 'rename':
                console.log(formatAccountLine(service.rename(parsed.accountId, parsed.label), false, Date.now()));
                return;
            case 'rm': {
                const { sessions, restarts } = await service.remove(parsed.accountId, parsed.force);
                console.log(`Removed ${parsed.accountId}.${sessions.length ? ` ${sessions.length} bound session(s) restarted and refuse to run until switched.` : ''}`);
                for (const [sessionId, outcome] of Object.entries(restarts ?? {})) if (outcome !== 'done') console.log(chalk.dim(`  ${sessionId}: restart ${outcome}`));
                return;
            }
            case 'default':
                service.setDefault('claude', parsed.accountId);
                console.log(parsed.accountId ? `New Claude sessions on this machine start on ${parsed.accountId}.` : 'New Claude sessions on this machine use the machine login.');
                return;
            case 'bind': {
                const result = await service.bind({ sessionId: parsed.sessionId, accountId: parsed.accountId, ...(parsed.model ? { model: parsed.model } : {}), restart: parsed.restart });
                const shown = bindResultMessages(result, parsed.sessionId, `${parsed.accountId ?? 'machine login'}${parsed.model ? ` / ${parsed.model}` : ''}`, 'account');
                for (const line of shown.out) console.log(line);
                for (const line of shown.err) console.error(chalk.yellow(line));
                if (shown.exitCode) process.exitCode = shown.exitCode;
                return;
            }
        }
    } catch (error) {
        if (error instanceof AccountError) {
            const extra = error.sessions?.length ? `\n  sessions: ${error.sessions.join(', ')}` : '';
            throw new Error(`${error.message} [${error.code}]${extra}`);
        }
        throw error;
    }
}
