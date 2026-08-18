#!/usr/bin/env node
/**
 * Reference implementation of the Happy todo provider contract.
 *
 * It stores todos in a plain JSON file, so you can wire up the web Todo panel
 * and see the whole path work without connecting any external service. Use it
 * as the shape to copy when you write a real provider for your own todo system
 * (Todoist, TickTick, Linear, a text file, whatever).
 *
 * The contract (full docs: docs/channels.md):
 *
 *   <command> list              -> {"items":[{"id":"...","title":"...", ...}]} on stdout
 *   <command> complete <id>     -> exit code is the result; output is not parsed
 *   <command> create <title>    -> exit code is the result; output is not parsed
 *
 * Exit 0 means success. On failure, exit non-zero and write something useful to
 * stderr — Happy shows that text to the user verbatim, so "permission denied for
 * project X" beats a silent failure.
 *
 * Only `id` and `title` are required on an item. `status` ('open' | 'done'),
 * `due`, `priority` ('none'|'low'|'medium'|'high'), `group` and `note` are
 * optional. Unknown fields are ignored, so you can add your own without
 * breaking older Happy clients.
 *
 * Enable it in ~/.happy/settings.json:
 *
 *   "todoProvider": {
 *     "command": "/absolute/path/to/todo-provider-jsonfile.mjs",
 *     "args": ["--file", "/absolute/path/to/todos.json"]
 *   }
 *
 * NOTE: this command runs as arbitrary code on the machine running the Happy
 * daemon, which is why it can only be configured in that machine's local
 * settings file and never from the web UI.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);

function optionValue(name, fallback) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const FILE = resolve(optionValue('--file', resolve(homedir(), '.happy', 'todos.example.json')));
// Everything that is not an option pair is positional: verb + operand.
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--file');
const [verb, operand] = positional;

function load() {
    try {
        const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
        return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
        return [];  // missing or corrupt file behaves as an empty list
    }
}

function save(items) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ items }, null, 2));
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

switch (verb) {
    case 'list': {
        // Happy only renders what you return here; filtering (e.g. hiding done
        // items) is the provider's call, not Happy's.
        process.stdout.write(JSON.stringify({ items: load().filter((t) => t.status !== 'done') }));
        break;
    }
    case 'complete': {
        if (!operand) fail('complete requires an id');
        const items = load();
        const target = items.find((t) => t.id === operand);
        if (!target) fail(`no todo with id ${operand}`);
        target.status = 'done';
        save(items);
        break;
    }
    case 'create': {
        if (!operand) fail('create requires a title');
        const items = load();
        items.unshift({
            id: `t${Date.now().toString(36)}`,
            title: operand,
            status: 'open',
            createdAt: new Date().toISOString(),  // an extra field Happy ignores
        });
        save(items);
        break;
    }
    default:
        fail(`unknown verb ${verb ?? '(none)'} — expected list | complete <id> | create <title>`);
}
