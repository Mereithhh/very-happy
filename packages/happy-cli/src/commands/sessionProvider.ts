/**
 * B-794: `very-happy session provider` — bind one Claude session to a
 * provider profile + model (claude/providerBinding.ts), then restart it in
 * place through the local daemon so the binding takes effect with its history.
 */
import chalk from 'chalk';
import { configuration } from '@/configuration';
import { restartDaemonSession } from '@/daemon/controlClient';
import {
    readProviders,
    readSessionProviders,
    sessionProvidersPath,
    updateBindings,
    writeSessionProviders,
    type ProvidersFile,
    type SessionProviderBinding,
} from '@/claude/providerBinding';

export const SESSION_PROVIDER_HELP = `Usage:
  very-happy session provider --list
  very-happy session provider <sessionId> <profile> [--model <model>] [--no-restart]
  very-happy session provider <sessionId> default [--no-restart]

Binds a Claude (SDK/remote) session on THIS machine to a provider profile from
$HAPPY_HOME_DIR/providers.json, then restarts the session in place (history
kept). "default" removes the binding. --model defaults to the profile's first model.`;

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

/** Pure: validate a `set` against the profiles and pick the model. */
export function resolveBindingRequest(providers: ProvidersFile, profile: string, model: string | undefined): SessionProviderBinding {
    const p = providers.profiles[profile];
    if (!p) {
        const known = Object.keys(providers.profiles);
        throw new Error(`unknown provider profile "${profile}"${known.length ? ` (known: ${known.join(', ')})` : ' (providers.json has no profiles)'}`);
    }
    const chosen = model ?? p.models?.[0];
    if (!chosen) throw new Error(`profile "${profile}" lists no models; pass --model`);
    if (p.models && p.models.length > 0 && !p.models.includes(chosen)) {
        throw new Error(`model "${chosen}" is not in profile "${profile}" models (${p.models.join(', ')})`);
    }
    return { profile, model: chosen };
}

export async function handleSessionProviderCommand(args: string[]): Promise<void> {
    const parsed = parseSessionProviderArgs(args);
    const home = configuration.happyHomeDir;
    if (parsed.action === 'help') {
        console.log(SESSION_PROVIDER_HELP);
        return;
    }
    const bindings = readSessionProviders(home);
    if (parsed.action === 'list') {
        const entries = Object.entries(bindings);
        if (entries.length === 0) console.log('No session provider bindings.');
        for (const [sessionId, b] of entries) console.log(`${sessionId}  ${b.profile}  ${b.model}`);
        return;
    }
    if (parsed.action === 'set') {
        const binding = resolveBindingRequest(readProviders(home), parsed.profile, parsed.model);
        writeSessionProviders(home, updateBindings(bindings, parsed.sessionId, binding));
        console.log(`Bound ${parsed.sessionId} → ${binding.profile} / ${binding.model} (${sessionProvidersPath(home)})`);
    } else {
        if (!bindings[parsed.sessionId]) {
            console.log(`${parsed.sessionId} has no binding; nothing to change.`);
            return;
        }
        writeSessionProviders(home, updateBindings(bindings, parsed.sessionId, null));
        console.log(`Cleared binding for ${parsed.sessionId} (default provider).`);
    }
    if (!parsed.restart) {
        console.log(chalk.dim('Not restarted; the binding applies when the session next starts.'));
        return;
    }
    const result = await restartDaemonSession(parsed.sessionId);
    if (result.success) {
        console.log(`Restarted ${parsed.sessionId} in place.`);
        return;
    }
    console.error(chalk.yellow(`Binding saved, but restart failed: ${result.error}`));
    console.error(chalk.dim('It applies the next time this session is resumed on this machine.'));
    process.exitCode = 1;
}
