import { configuration } from '@/configuration';
import { authenticatedBuiltinTodoClient } from '@/modules/todo/builtinTodoClient';
import { BUILTIN_TODO_SKILL } from '@/modules/todo/skill';

export const TODO_HELP = `very-happy todo — account-owned built-in Todos (JSON output)
  very-happy todo list
  very-happy todo get ID
  very-happy todo add --id UUID --title TEXT [--note TEXT]
  very-happy todo edit ID --version N [--title TEXT] [--note TEXT]
  very-happy todo complete|reopen|delete ID --version N
  very-happy todo skill

Use the version returned by list/get. Conflicts require reading the latest task
before deciding what to change. Reuse the same add UUID and arguments after an
unknown result. Use --title=TEXT or --note=TEXT for values starting with --.
These commands use the current relay and login; they do not
operate external providers or agent execution plans. skill prints the official
instructions without authentication. Pass --help for this reference.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Action = 'list' | 'get' | 'add' | 'edit' | 'complete' | 'reopen' | 'delete' | 'skill' | 'help';
export interface TodoCommand { action: Action; id?: string; version?: number; title?: string; note?: string }

export function parseTodoArgs(args: string[]): TodoCommand {
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { action: 'help' };
    const action = args[0] as Action;
    if (!['list', 'get', 'add', 'edit', 'complete', 'reopen', 'delete', 'skill'].includes(action)) throw new Error('Unknown Todo command; use todo --help');
    if (args.length === 2 && args[1] === '--help') return { action: 'help' };
    const flags: Record<string, string> = {};
    let id: string | undefined;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const separator = arg.indexOf('=');
            const flag = separator === -1 ? arg : arg.slice(0, separator);
            if (!['--id', '--version', '--title', '--note'].includes(flag)
                || (separator !== -1 && flag !== '--title' && flag !== '--note')) throw new Error(`Unknown Todo option: ${arg}`);
            if (Object.hasOwn(flags, flag)) throw new Error(`Duplicate Todo option: ${flag}`);
            // Equals syntax makes leading dashes and empty notes unambiguous.
            const value = separator === -1 ? args[++i] : arg.slice(separator + 1);
            if (value === undefined || (separator === -1 && value.startsWith('--'))) throw new Error(`Missing value for ${flag}`);
            flags[flag] = value;
        } else {
            if (id !== undefined) throw new Error('Unexpected Todo argument');
            id = arg;
        }
    }
    const allowed = action === 'add' ? ['--id', '--title', '--note'] : action === 'edit' ? ['--version', '--title', '--note'] : ['complete', 'reopen', 'delete'].includes(action) ? ['--version'] : [];
    for (const flag of Object.keys(flags)) if (!allowed.includes(flag)) throw new Error(`${flag} is not supported for ${action}`);
    const needsId = ['get', 'edit', 'complete', 'reopen', 'delete'].includes(action);
    if (needsId ? !id || !UUID.test(id) : id !== undefined) throw new Error(needsId ? 'A valid Todo UUID is required' : 'Unexpected Todo ID');
    if (action === 'add' && (!flags['--id'] || !UUID.test(flags['--id']))) throw new Error('add requires --id UUID; reuse it when retrying');
    if (action === 'add' && flags['--title'] === undefined) throw new Error('add requires --title');
    if (action === 'edit' && flags['--title'] === undefined && flags['--note'] === undefined) throw new Error('edit requires --title or --note');
    if (flags['--title'] !== undefined && (!flags['--title'].trim() || flags['--title'].trim().length > 500)) throw new Error('Todo title must contain 1–500 characters');
    if (flags['--note'] !== undefined && flags['--note'].length > 8000) throw new Error('Todo note exceeds 8000 characters');
    let version: number | undefined;
    if (['edit', 'complete', 'reopen', 'delete'].includes(action)) {
        const value = flags['--version'];
        if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('A non-negative safe integer --version is required');
        version = Number(value);
    }
    return { action, id: action === 'add' ? flags['--id'] : id, version, title: flags['--title'], note: flags['--note'] };
}

export async function handleTodoCommand(args: string[]): Promise<void> {
    const command = parseTodoArgs(args);
    if (command.action === 'help') { console.log(TODO_HELP); return; }
    if (command.action === 'skill') { console.log(BUILTIN_TODO_SKILL); return; }
    const client = await authenticatedBuiltinTodoClient();
    let result: unknown;
    if (command.action === 'list') result = await client.list();
    else if (command.action === 'add') result = await client.create(command.title!, command.note ?? '', command.id!);
    else {
        const record = await client.get(command.id!);
        if (command.action === 'get') result = record;
        else {
            if (!record) throw new Error('Todo not found; it may have been deleted.');
            if (record.version !== command.version) throw new Error('Todo version conflict; read the latest task before deciding what to change.');
            if (command.action === 'delete') { await client.remove(record); result = { id: record.id, deleted: true }; }
            else result = await client.update(record, command.action === 'edit'
                ? { ...(command.title !== undefined ? { title: command.title } : {}), ...(command.note !== undefined ? { note: command.note } : {}) }
                : { status: command.action === 'complete' ? 'done' : 'open' });
        }
    }
    console.log(JSON.stringify({ serverUrl: configuration.serverUrl, result }));
}
