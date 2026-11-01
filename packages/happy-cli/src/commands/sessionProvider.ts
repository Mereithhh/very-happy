/**
 * B-794: `very-happy session provider` — kept as an alias of
 * `very-happy account bind` (B-850a). A "profile" is any account id
 * (providers.json profiles are listed as legacy accounts); the binding is
 * written to session-accounts.json and the session restarts in place.
 */
import chalk from 'chalk';
import { configuration } from '@/configuration';
import { listDaemonSessions, restartDaemonSession } from '@/daemon/controlClient';
import { AccountService } from '@/agentProfiles/accountService';
import { readAccounts, readSessionBindings, sessionAccountsPath, type AccountsFile } from '@/agentProfiles/store';

export const SESSION_PROVIDER_HELP = `Usage:
  very-happy session provider --list
  very-happy session provider <sessionId> <profile> [--model <model>] [--no-restart]
  very-happy session provider <sessionId> default [--no-restart]

Alias of \`very-happy account bind\`. Binds a Claude session on THIS machine to
an account (\`very-happy account list\`; providers.json profiles are included),
then restarts it in place (history kept). "default" = the machine login.
--model defaults to the account's first model.`;

export type SessionProviderArgs =
    | { action: 'help' }
    | { action: 'list' }
    | { action: 'set'; sessionId: string; profile: string; model?: string; restart: boolean }
    | { action: 'clear'; sessionId: string; restart: boolean };

export function parseSessionProviderArgs(args: string[]): SessionProviderArgs {
    const positional: string[] = [];
    let model: string | undefined;
    let restart = true;
    let list = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') return { action: 'help' };
        if (arg === '--list') list = true;
        else if (arg === '--no-restart') restart = false;
        else if (arg === '--model') {
            model = args[++i];
            if (!model) throw new Error('--model needs a value');
        } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
        else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else positional.push(arg);
    }
    if (list) {
        if (positional.length > 0) throw new Error('--list takes no session id');
        return { action: 'list' };
    }
    if (positional.length === 0) return { action: 'help' };
    if (positional.length !== 2) throw new Error('expected <sessionId> <profile|default>');
    const [sessionId, profile] = positional;
    if (profile === 'default') {
        if (model) throw new Error('--model cannot be used with default');
        return { action: 'clear', sessionId, restart };
    }
    return { action: 'set', sessionId, profile, model, restart };
}

/** Pure: validate a `set` against the accounts and pick the model (API accounts). */
export function resolveBindingRequest(accounts: AccountsFile, profile: string, model: string | undefined): { account: string; model?: string } {
    const a = accounts.accounts[profile];
    if (!a) {
        const known = Object.keys(accounts.accounts);
        throw new Error(`unknown account "${profile}"${known.length ? ` (known: ${known.join(', ')})` : ' (no accounts; see `very-happy account`)'}`);
    }
    if (a.kind !== 'claude-api') {
        if (model) throw new Error(`--model applies to API accounts only`);
        return { account: profile };
    }
    const chosen = model ?? a.models?.[0];
    if (chosen && a.models && a.models.length > 0 && !a.models.includes(chosen)) {
        throw new Error(`model "${chosen}" is not in account "${profile}" models (${a.models.join(', ')})`);
    }
    return { account: profile, ...(chosen ? { model: chosen } : {}) };
}

export async function handleSessionProviderCommand(args: string[]): Promise<void> {
    const parsed = parseSessionProviderArgs(args);
    const home = configuration.happyHomeDir;
    if (parsed.action === 'help') {
        console.log(SESSION_PROVIDER_HELP);
        return;
    }
    if (parsed.action === 'list') {
        const entries = Object.entries(readSessionBindings(home));
        if (entries.length === 0) console.log('No session account bindings.');
        for (const [sessionId, b] of entries) console.log(`${sessionId}  ${b.account ?? 'machine'}${b.model ? `  ${b.model}` : ''}`);
        return;
    }
    const service = new AccountService({
        home,
        restartSession: async (sessionId) => {
            const result = await restartDaemonSession(sessionId);
            if (result.success) return { ok: true };
            const stillRunning = await listDaemonSessions().then((children) => children.some((c) => c?.happySessionId === sessionId), () => false);
            return { ok: false, stillRunning, error: result.error ?? 'restart failed' };
        },
    });
    const binding = parsed.action === 'set' ? resolveBindingRequest(readAccounts(home), parsed.profile, parsed.model) : null;
    const result = await service.bind({ sessionId: parsed.sessionId, accountId: binding?.account ?? null, ...(binding?.model ? { model: binding.model } : {}), restart: parsed.restart });
    console.log(binding
        ? `Bound ${parsed.sessionId} → ${binding.account}${binding.model ? ` / ${binding.model}` : ''} (${sessionAccountsPath(home)})`
        : `${parsed.sessionId} → machine login.`);
    if (result.restart === 'done') {
        console.log(`Restarted ${parsed.sessionId} in place.`);
    } else if (result.restart === 'skipped' || result.restart === 'pending') {
        console.log(chalk.dim('Not restarted; the binding applies when the session next starts.'));
    } else if (result.rolledBack) {
        console.error(chalk.yellow(`Restart failed: ${result.error}. The session keeps running on its previous provider; the binding was not changed.`));
        process.exitCode = 1;
    } else {
        console.error(chalk.yellow(`Binding saved, but restart failed: ${result.error}`));
        console.error(chalk.dim('It applies the next time this session is resumed on this machine.'));
        process.exitCode = 1;
    }
}
