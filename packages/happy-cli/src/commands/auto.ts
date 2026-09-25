/**
 * `very-happy auto` — manage B-496 Automations from a terminal.
 *
 *   very-happy auto list | show <name> | create … | edit <name> … | pause | resume | rm
 *   very-happy auto run <name> | fire <name> [--payload…] [--dedupe-key] [--wait]
 *   very-happy auto runs [--name] [--status] [--attention] | runs <runId> | cancel <runId> | ack <runId>
 *   very-happy auto report [--run <id>] --status done|failed [--summary] [--error] [--attention <reason>]
 *   very-happy auto skill | install --host … [--apply]
 *
 * `--json` prints the server objects verbatim. The default machine is this
 * one (`~/.happy/settings.json` machineId); `--machine <id>` targets another.
 * A server without automations (old, or gate off) is reported in one line.
 *
 * Exit codes: 0 ok; 1 error; 2 `--wait` timed out (the run may still finish);
 * 3 the awaited run ended in failed / expired / cancelled / skipped.
 */
import chalk from 'chalk';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUTOMATION_NAME_PATTERN, isAutomationRunTerminal, type Automation, type AutomationAction, type AutomationCreate, type AutomationReport, type AutomationRun, type AutomationUpdate } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { authenticatedAutomationsClient, automationRunIdFromEnv, isAutomationsUnavailable, AUTOMATIONS_UNAVAILABLE_MESSAGE, type AutomationsClient } from '@/automations/client';
import { describeAction, describeTrigger, parseDuration, triggerFromFlags } from '@/automations/template';
import { AUTOMATION_SKILL } from '@/automations/resources';
import { installAutomationSkill } from '@/automations/install';
import { sessionWebUrl } from './sessionMessage';
import { parseEnvAssignment, SPAWN_AGENTS } from './spawn';
import { ALLOWED_SPAWN_PERMISSION_MODES, sanitizeSpawnPermissionMode } from '@/daemon/spawnPermissionMode';
import { delay } from '@/utils/time';

export const AUTO_ACTIONS = ['list', 'show', 'create', 'edit', 'pause', 'resume', 'rm', 'run', 'fire', 'runs', 'cancel', 'ack', 'report', 'skill', 'install', 'uninstall', 'help'] as const;
export type AutoAction = typeof AUTO_ACTIONS[number];

const VALUE_FLAGS = ['--name', '--rename', '--description', '--machine', '--cron', '--tz', '--every', '--at', '--spawn-dir', '--prompt', '--prompt-file', '--agent', '--model', '--permission-mode', '--sticky-key', '--send-session', '--cwd', '--env', '--timeout', '--concurrency', '--max-runtime', '--payload', '--payload-json', '--payload-file', '--dedupe-key', '--status', '--limit', '--run', '--summary', '--error', '--attention', '--host', '--home'] as const;
const BOOL_FLAGS = ['--manual', '--script', '--worktree', '--paused', '--wait', '--json', '--apply', '--all-machines', '--attention', '--help', '-h'] as const;
type ValueFlag = typeof VALUE_FLAGS[number];
type BoolFlag = typeof BOOL_FLAGS[number];

export interface AutoCommand {
    action: AutoAction;
    /** Automation name or run id, depending on the action. */
    target?: string;
    flags: Partial<Record<ValueFlag, string>>;
    /** Repeatable flags. */
    env: string[];
    bools: Set<BoolFlag>;
    /** Script argv after `--`. */
    argv: string[];
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseAutoArgs(args: string[]): AutoCommand {
    const command: AutoCommand = { action: 'help', flags: {}, env: [], bools: new Set(), argv: [] };
    if (args.length === 0) return command;
    const separator = args.indexOf('--');
    const head = separator === -1 ? args : args.slice(0, separator);
    command.argv = separator === -1 ? [] : args.slice(separator + 1);
    const action = head[0];
    if (action === '--help' || action === '-h') return command;
    if (!(AUTO_ACTIONS as readonly string[]).includes(action)) throw new Error(`Unknown auto command: ${action} (see auto --help)`);
    command.action = action as AutoAction;
    for (let i = 1; i < head.length; i++) {
        const arg = head[i];
        // `--attention` is a filter for `runs` and takes a reason for `report`.
        if ((BOOL_FLAGS as readonly string[]).includes(arg) && !(arg === '--attention' && command.action === 'report')) { command.bools.add(arg as BoolFlag); continue; }
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            const flag = (eq === -1 ? arg : arg.slice(0, eq)) as ValueFlag;
            if (!(VALUE_FLAGS as readonly string[]).includes(flag)) throw new Error(`Unknown option: ${arg}`);
            const value = eq === -1 ? head[++i] : arg.slice(eq + 1);
            if (value === undefined) throw new Error(`${flag} requires a value`);
            if (flag === '--env') { command.env.push(value); continue; }
            if (command.flags[flag] !== undefined) throw new Error(`Duplicate option: ${flag}`);
            command.flags[flag] = value;
            continue;
        }
        if (command.target !== undefined) throw new Error(`Unexpected argument: ${arg}`);
        command.target = arg;
    }
    if (command.bools.has('--help') || command.bools.has('-h')) command.action = 'help';
    if (command.argv.length > 0 && !command.bools.has('--script')) throw new Error('Arguments after -- need --script');
    return command;
}

function readPrompt(flags: AutoCommand['flags']): string | undefined {
    if (flags['--prompt'] !== undefined && flags['--prompt-file'] !== undefined) throw new Error('--prompt and --prompt-file are mutually exclusive');
    if (flags['--prompt-file'] !== undefined) return readFileSync(resolve(flags['--prompt-file']), 'utf8');
    return flags['--prompt'];
}

function readPayload(flags: AutoCommand['flags']): string | undefined {
    const given = ['--payload', '--payload-json', '--payload-file'].filter((flag) => flags[flag as ValueFlag] !== undefined);
    if (given.length > 1) throw new Error('Use only one of --payload, --payload-json, --payload-file');
    if (flags['--payload-json'] !== undefined) { try { JSON.parse(flags['--payload-json']); } catch { throw new Error('--payload-json is not valid JSON'); } return flags['--payload-json']; }
    if (flags['--payload-file'] !== undefined) return readFileSync(resolve(flags['--payload-file']), 'utf8');
    return flags['--payload'];
}

/** Action from flags; `undefined` when no action flag was given (edit keeps the old one). Pure apart from prompt-file reads. */
export function actionFromCommand(command: AutoCommand, current?: AutomationAction): AutomationAction | undefined {
    const { flags, bools } = command;
    const kinds = [flags['--spawn-dir'] !== undefined, flags['--send-session'] !== undefined, bools.has('--script')].filter(Boolean).length;
    if (kinds > 1) throw new Error('Use only one of --spawn-dir, --send-session, --script');
    const prompt = readPrompt(flags);
    const spawnOnly = ['--agent', '--model', '--permission-mode', '--sticky-key'].filter((flag) => flags[flag as ValueFlag] !== undefined).concat(bools.has('--worktree') ? ['--worktree'] : []);
    const scriptOnly = ['--cwd', '--timeout'].filter((flag) => flags[flag as ValueFlag] !== undefined).concat(command.env.length ? ['--env'] : []);
    if (kinds === 0) {
        // Editing details of the existing action without restating its kind.
        if (!current) {
            if (prompt !== undefined || spawnOnly.length || scriptOnly.length) throw new Error('Give an action: --spawn-dir <dir>, --send-session <id>, or --script -- <argv…>');
            return undefined;
        }
        if (prompt === undefined && spawnOnly.length === 0 && scriptOnly.length === 0) return undefined;
        if (current.kind === 'script') {
            if (prompt !== undefined || spawnOnly.length) throw new Error(`${current.kind} actions do not take ${[...(prompt !== undefined ? ['--prompt'] : []), ...spawnOnly].join(', ')}`);
            return { ...current, ...(flags['--cwd'] !== undefined ? { cwd: flags['--cwd'] } : {}), ...(flags['--timeout'] !== undefined ? { timeoutMs: parseDuration(flags['--timeout']) } : {}), ...(command.env.length ? { env: Object.fromEntries(command.env.map(parseEnvAssignment)) } : {}) };
        }
        if (scriptOnly.length) throw new Error(`${current.kind} actions do not take ${scriptOnly.join(', ')}`);
        if (current.kind === 'send') {
            if (spawnOnly.length) throw new Error(`send actions do not take ${spawnOnly.join(', ')}`);
            return { ...current, ...(prompt !== undefined ? { prompt } : {}) };
        }
        return { ...current, ...(prompt !== undefined ? { prompt } : {}), ...spawnDetails(command) };
    }
    if (bools.has('--script')) {
        if (command.argv.length === 0) throw new Error('--script needs the command after --, e.g. --script -- /usr/bin/env python3 job.py');
        if (prompt !== undefined || spawnOnly.length) throw new Error(`script actions do not take ${[...(prompt !== undefined ? ['--prompt'] : []), ...spawnOnly].join(', ')}`);
        return { kind: 'script', command: command.argv, ...(flags['--cwd'] !== undefined ? { cwd: flags['--cwd'] } : {}), ...(flags['--timeout'] !== undefined ? { timeoutMs: parseDuration(flags['--timeout']) } : {}), ...(command.env.length ? { env: Object.fromEntries(command.env.map(parseEnvAssignment)) } : {}) };
    }
    if (scriptOnly.length) throw new Error(`${flags['--send-session'] !== undefined ? 'send' : 'spawn'} actions do not take ${scriptOnly.join(', ')}`);
    if (prompt === undefined) throw new Error('--prompt or --prompt-file is required');
    if (prompt.trim().length === 0) throw new Error('Prompt is empty');
    if (flags['--send-session'] !== undefined) {
        if (spawnOnly.length) throw new Error(`send actions do not take ${spawnOnly.join(', ')}`);
        return { kind: 'send', sessionId: flags['--send-session'], prompt };
    }
    return { kind: 'spawn', agent: flags['--agent'] ?? 'claude', directory: resolve(flags['--spawn-dir']!), prompt, ...spawnDetails(command) };
}

function spawnDetails(command: AutoCommand): Partial<Extract<AutomationAction, { kind: 'spawn' }>> {
    const { flags, bools } = command;
    if (flags['--agent'] !== undefined && !(SPAWN_AGENTS as readonly string[]).includes(flags['--agent'])) throw new Error(`--agent must be one of: ${SPAWN_AGENTS.join(', ')}`);
    if (flags['--permission-mode'] !== undefined && sanitizeSpawnPermissionMode(flags['--permission-mode']) === null) throw new Error(`--permission-mode must be one of: ${ALLOWED_SPAWN_PERMISSION_MODES.join(', ')}`);
    return {
        ...(flags['--agent'] !== undefined ? { agent: flags['--agent'] } : {}),
        ...(flags['--model'] !== undefined ? { model: flags['--model'] } : {}),
        ...(flags['--permission-mode'] !== undefined ? { permissionMode: flags['--permission-mode'] } : {}),
        ...(bools.has('--worktree') ? { worktree: true } : {}),
        ...(flags['--sticky-key'] !== undefined ? { sticky: { key: flags['--sticky-key'] } } : {}),
    };
}

export const AUTO_HELP = `${chalk.bold('very-happy auto')} - account-level automations: cron / interval / one-shot / manual triggers that spawn a session, continue a sticky session, or run a script on a machine

${chalk.bold('Usage:')}
  very-happy auto list [--all-machines] [--json]
  very-happy auto show <name> [--json]
  very-happy auto create --name <name> <trigger> <action> [options]
  very-happy auto edit <name> [<trigger>] [<action changes>] [--rename <new>] [options]
  very-happy auto pause|resume|rm <name>
  very-happy auto run <name> [--payload… ] [--wait [--timeout <dur>]]
  very-happy auto fire <name> [--payload…] [--dedupe-key <key>] [--wait [--timeout <dur>]]
  very-happy auto runs [--name <name>] [--status <s>] [--attention] [--limit <n>] [--json]
  very-happy auto runs <runId> [--json]
  very-happy auto cancel <runId> | ack <runId>
  very-happy auto report [--run <id>] --status done|failed [--summary <text>] [--error <text>] [--attention <reason>]
  very-happy auto skill | install|uninstall --host claude|codex|pi [--home <path>] [--apply]

${chalk.bold('Trigger (one):')}
  --cron '<5 fields>' --tz <IANA zone>   e.g. --cron '0 9 * * 1-5' --tz Asia/Singapore
  --every <dur>                          e.g. 5m, 1h30m (minimum 1m)
  --at <ISO timestamp>                   one time
  --manual                               only \`run\` / \`fire\`

${chalk.bold('Action (one):')}
  --spawn-dir <dir> --prompt <text>|--prompt-file <file>
      [--agent claude|codex|pi|gemini|openclaw] [--model <id>] [--permission-mode <m>]
      [--worktree] [--sticky-key <template>]
  --send-session <id> --prompt <text>|--prompt-file <file>
  --script -- <argv…> [--cwd <dir>] [--env K=V]... [--timeout <dur>]

${chalk.bold('Options:')}
  --machine <id>|this     Executing machine (default: this machine)
  --description <text>
  --concurrency skip|queue  skip (default) records a run as skipped while one is active
  --max-runtime <dur>     Bound per run (default 6h; scripts 30m)
  --paused                Create paused
  --payload <text> | --payload-json <json> | --payload-file <file>
  --wait                  run/fire: wait for the run to finish (--timeout, default 10m)
  Inside a continued (sticky) session pass --run <id> from the latest prompt header;
  $VH_AUTOMATION_RUN_ID is the run that started the session.
  --json                  Machine-readable output

${chalk.bold('Templates')} in prompts, argv and sticky keys: {{payload}}, {{payload.a.b}}, {{run.id}}, {{automation.name}}, {{now}}.
Inside an automation-started session \`report\` defaults --run to $VH_AUTOMATION_RUN_ID.

${chalk.bold('Exit codes:')} 0 ok · 1 error · 2 --wait timed out · 3 run ended (or was created) failed/expired/cancelled/skipped`;

function fmtTime(value: number | null | undefined): string { return typeof value === 'number' ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '-'; }

function printAutomation(a: Automation): void {
    console.log(`${chalk.bold(a.name)}  ${a.status === 'paused' ? chalk.yellow('paused') : chalk.green('active')}  v${a.version}  ${chalk.dim(a.id)}`);
    if (a.description) console.log(`  ${a.description}`);
    console.log(`  trigger:   ${describeTrigger(a.trigger)}   next: ${fmtTime(a.nextRunAt)}`);
    console.log(`  action:    ${describeAction(a.action)}`);
    console.log(`  machine:   ${a.machineId}   concurrency: ${a.concurrency}   max runtime: ${Math.round(a.maxRuntimeMs / 60_000)}m`);
    console.log(`  last run:  ${fmtTime(a.lastRunAt)} ${a.lastRunStatus ?? ''}`);
}

function runLine(run: AutomationRun): string {
    const status = run.status === 'done' ? chalk.green(run.status) : ['failed', 'expired'].includes(run.status) ? chalk.red(run.status) : run.status === 'running' ? chalk.cyan(run.status) : run.status;
    return `${fmtTime(run.createdAt)}  ${status.padEnd(9)}  ${run.automationName.padEnd(20)}  ${run.source.padEnd(8)}  ${run.id}${run.needsAttention ? chalk.yellow(`  ! ${run.attentionReason ?? 'attention'}`) : ''}`;
}

function printRun(run: AutomationRun): void {
    console.log(runLine(run));
    if (run.sessionId) console.log(`  session: ${sessionWebUrl(run.sessionId)}`);
    if (run.stickyKey) console.log(`  sticky:  ${run.stickyKey}`);
    if (run.error) console.log(`  error:   ${run.error}`);
    if (run.summary) console.log(`  summary: ${run.summary.split('\n').join('\n           ')}`);
    if (run.exitCode !== null && run.exitCode !== undefined) console.log(`  exit:    ${run.exitCode}`);
}

async function waitForRun(client: AutomationsClient, runId: string, timeoutMs: number): Promise<AutomationRun | null> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const run = await client.getRun(runId);
        if (isAutomationRunTerminal(run.status)) return run;
        if (Date.now() + 3_000 > deadline) return null;
        await delay(3_000);
    }
}

export async function handleAutoCommand(args: string[]): Promise<void> {
    let command: AutoCommand;
    try { command = parseAutoArgs(args); }
    catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        console.error(`Run ${chalk.cyan('very-happy auto --help')} for usage.`);
        process.exitCode = 1; return;
    }
    const json = command.bools.has('--json');
    if (command.action === 'help') { console.log(AUTO_HELP); return; }
    if (command.action === 'skill') { console.log(AUTOMATION_SKILL); return; }
    if (command.action === 'install' || command.action === 'uninstall') {
        const host = command.flags['--host'];
        if (!host || !['claude', 'codex', 'pi'].includes(host)) throw new Error('--host must be claude, codex, or pi');
        console.log(JSON.stringify(await installAutomationSkill({ host: host as 'claude' | 'codex' | 'pi', home: command.flags['--home'] ?? homedir(), apply: command.bools.has('--apply'), uninstall: command.action === 'uninstall' })));
        return;
    }
    const needsName: AutoAction[] = ['show', 'edit', 'pause', 'resume', 'rm', 'run', 'fire'];
    const needsRunId: AutoAction[] = ['cancel', 'ack'];
    if (needsName.includes(command.action) && !command.target) throw new Error(`${command.action} needs an automation name`);
    if (needsRunId.includes(command.action) && !command.target) throw new Error(`${command.action} needs a run id`);
    if (command.action === 'create' && !command.flags['--name']) throw new Error('create needs --name <name>');
    for (const name of [command.flags['--name'], command.flags['--rename'], needsName.includes(command.action) ? command.target : undefined]) {
        if (name !== undefined && !AUTOMATION_NAME_PATTERN.test(name)) throw new Error(`Invalid automation name "${name}": use [a-z0-9][a-z0-9-_.]{0,63}`);
    }

    const { client, machineId } = await authenticatedAutomationsClient();
    const machine = (requested: string | undefined): string => {
        if (requested && requested !== 'this') return requested;
        if (!machineId) throw new Error('This machine is not registered with Very Happy; pass --machine <id>');
        return machineId;
    };
    try {
        switch (command.action) {
            case 'list': {
                const automations = await client.list(command.bools.has('--all-machines') ? undefined : machine(command.flags['--machine']));
                if (json) { console.log(JSON.stringify({ serverUrl: configuration.serverUrl, automations })); return; }
                if (automations.length === 0) { console.log('No automations' + (command.bools.has('--all-machines') ? '.' : ' on this machine (try --all-machines).')); return; }
                for (const a of automations) console.log(`${(a.status === 'paused' ? chalk.yellow('paused') : chalk.green('active')).padEnd(6)}  ${a.name.padEnd(24)}  ${describeTrigger(a.trigger).padEnd(32)}  next ${fmtTime(a.nextRunAt)}  ${describeAction(a.action)}`);
                return;
            }
            case 'show': {
                const automation = await client.getByName(command.target!);
                const runs = await client.runs({ automationId: automation.id, limit: 5 });
                if (json) { console.log(JSON.stringify({ automation, runs })); return; }
                printAutomation(automation);
                if (runs.length) { console.log('  recent runs:'); for (const run of runs) console.log(`    ${runLine(run)}`); }
                return;
            }
            case 'create': {
                const trigger = triggerFromFlags({ cron: command.flags['--cron'], tz: command.flags['--tz'], every: command.flags['--every'], at: command.flags['--at'], manual: command.bools.has('--manual') });
                if (!trigger) throw new Error('Give a trigger: --cron <expr> --tz <zone>, --every <dur>, --at <iso>, or --manual');
                const action = actionFromCommand(command);
                if (!action) throw new Error('Give an action: --spawn-dir <dir>, --send-session <id>, or --script -- <argv…>');
                const input: AutomationCreate = {
                    name: command.flags['--name']!, machineId: machine(command.flags['--machine']), trigger, action,
                    ...(command.flags['--description'] !== undefined ? { description: command.flags['--description'] } : {}),
                    ...(command.flags['--concurrency'] !== undefined ? { concurrency: concurrency(command.flags['--concurrency']) } : {}),
                    ...(command.flags['--max-runtime'] !== undefined ? { maxRuntimeMs: parseDuration(command.flags['--max-runtime']) } : {}),
                    ...(command.bools.has('--paused') ? { status: 'paused' as const } : {}),
                };
                const automation = await client.create(input);
                if (json) { console.log(JSON.stringify({ automation })); return; }
                console.log(chalk.green('Created.')); printAutomation(automation);
                return;
            }
            case 'edit': {
                const current = await client.getByName(command.target!);
                const trigger = triggerFromFlags({ cron: command.flags['--cron'], tz: command.flags['--tz'], every: command.flags['--every'], at: command.flags['--at'], manual: command.bools.has('--manual') });
                const action = actionFromCommand(command, current.action);
                const input: AutomationUpdate = {
                    version: current.version,
                    ...(command.flags['--rename'] !== undefined ? { name: command.flags['--rename'] } : {}),
                    ...(command.flags['--description'] !== undefined ? { description: command.flags['--description'] } : {}),
                    ...(command.flags['--machine'] !== undefined ? { machineId: machine(command.flags['--machine']) } : {}),
                    ...(trigger ? { trigger } : {}), ...(action ? { action } : {}),
                    ...(command.flags['--concurrency'] !== undefined ? { concurrency: concurrency(command.flags['--concurrency']) } : {}),
                    ...(command.flags['--max-runtime'] !== undefined ? { maxRuntimeMs: parseDuration(command.flags['--max-runtime']) } : {}),
                };
                if (Object.keys(input).length === 1) throw new Error('Nothing to change');
                const automation = await client.update(current.id, input);
                if (json) { console.log(JSON.stringify({ automation })); return; }
                console.log(chalk.green('Updated.')); printAutomation(automation);
                return;
            }
            case 'pause': case 'resume': {
                const current = await client.getByName(command.target!);
                const automation = command.action === 'pause' ? await client.pause(current.id) : await client.resume(current.id);
                if (json) { console.log(JSON.stringify({ automation })); return; }
                console.log(`${automation.name}: ${automation.status}${automation.nextRunAt ? `, next ${fmtTime(automation.nextRunAt)}` : ''}`);
                return;
            }
            case 'rm': {
                const current = await client.getByName(command.target!);
                await client.remove(current.id);
                if (json) { console.log(JSON.stringify({ deleted: true, id: current.id, name: current.name })); return; }
                console.log(`Deleted ${current.name} and its runs.`);
                return;
            }
            case 'run': case 'fire': {
                const payload = readPayload(command.flags);
                let run: AutomationRun; let deduplicated = false;
                if (command.action === 'fire') {
                    const fired = await client.fire(command.target!, { ...(payload !== undefined ? { payload } : {}), ...(command.flags['--dedupe-key'] !== undefined ? { dedupeKey: command.flags['--dedupe-key'] } : {}) });
                    run = fired.run; deduplicated = fired.deduplicated;
                } else {
                    if (command.flags['--dedupe-key'] !== undefined) throw new Error('--dedupe-key only applies to fire');
                    run = await client.run((await client.getByName(command.target!)).id, payload !== undefined ? { payload } : {});
                }
                if (!json) { console.log(`${deduplicated ? 'Existing run' : 'Run'} ${run.id}: ${run.status}`); }
                if (command.bools.has('--wait') && !isAutomationRunTerminal(run.status)) {
                    const timeoutMs = command.flags['--timeout'] !== undefined ? parseDuration(command.flags['--timeout']) : 600_000;
                    const final = await waitForRun(client, run.id, timeoutMs);
                    if (!final) {
                        if (json) console.log(JSON.stringify({ run, deduplicated, timedOut: true }));
                        else console.error(chalk.yellow(`Run ${run.id} did not finish within ${Math.round(timeoutMs / 1000)}s (it may still complete).`));
                        process.exitCode = 2; return;
                    }
                    run = final;
                }
                if (json) { console.log(JSON.stringify({ run, deduplicated })); }
                else if (command.bools.has('--wait') || isAutomationRunTerminal(run.status)) printRun(run);
                else if (run.sessionId) console.log(`  session: ${sessionWebUrl(run.sessionId)}`);
                // A run that is already terminal but not done (skipped while another was active, …) is a failure for scripts.
                if (isAutomationRunTerminal(run.status) && run.status !== 'done') process.exitCode = 3;
                return;
            }
            case 'runs': {
                if (command.target) {
                    const run = await client.getRun(command.target);
                    if (json) console.log(JSON.stringify({ run })); else printRun(run);
                    return;
                }
                const limit = command.flags['--limit'] !== undefined ? Number(command.flags['--limit']) : undefined;
                if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit must be a positive integer');
                const runs = await client.runs({ name: command.flags['--name'], status: command.flags['--status'], attention: command.bools.has('--attention'), limit });
                if (json) { console.log(JSON.stringify({ runs })); return; }
                if (runs.length === 0) { console.log('No runs.'); return; }
                for (const run of runs) console.log(runLine(run));
                return;
            }
            case 'cancel': case 'ack': {
                const run = command.action === 'cancel' ? await client.cancel(command.target!) : await client.ack(command.target!);
                if (json) console.log(JSON.stringify({ run })); else printRun(run);
                return;
            }
            case 'report': {
                const runId = command.flags['--run'] ?? automationRunIdFromEnv();
                if (!runId) throw new Error('--run <id> is required outside an automation-started session (VH_AUTOMATION_RUN_ID is not set)');
                const status = command.flags['--status'];
                if (status !== 'done' && status !== 'failed') throw new Error('--status must be done or failed');
                const report: AutomationReport = {
                    status,
                    ...(command.flags['--summary'] !== undefined ? { summary: command.flags['--summary'] } : {}),
                    ...(command.flags['--error'] !== undefined ? { error: command.flags['--error'] } : {}),
                    ...(command.flags['--attention'] !== undefined ? { needsAttention: true, attentionReason: command.flags['--attention'] } : {}),
                };
                const run = await client.report(runId, report);
                if (json) console.log(JSON.stringify({ run })); else printRun(run);
                return;
            }
            default: throw new Error(`Unhandled auto command: ${command.action}`);
        }
    } catch (error) {
        if (isAutomationsUnavailable(error)) throw new Error(AUTOMATIONS_UNAVAILABLE_MESSAGE);
        throw error;
    }
}

function concurrency(value: string): 'skip' | 'queue' {
    if (value !== 'skip' && value !== 'queue') throw new Error('--concurrency must be skip or queue');
    return value;
}
