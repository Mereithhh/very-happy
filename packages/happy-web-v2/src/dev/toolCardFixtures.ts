/**
 * B-754 tool-card examples, one per tool shape the runners emit. The shapes
 * (names, input keys, result envelopes) are copied from real transcripts and
 * the CLI mappers; every value is a local example — paths, ids and text are
 * invented or shortened. Shared by the dev harness (`/dev/tool-cards/:id`)
 * and the rendering tests, so a screenshot and a test always see the same
 * call.
 */
import type { ToolCallMessage } from '@/sync/typesMessage';

const T0 = 1_760_000_000_000;
let seq = 0;

export type ToolFixture = { id: string; runner: 'claude' | 'codex' | 'gemini' | 'pi' | 'mcp'; title: string; message: ToolCallMessage };

/** An MCP / Claude tool_result content-block array. */
export const mcpText = (value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

function fixture(
    runner: ToolFixture['runner'], title: string, name: string, input: unknown,
    state: ToolCallMessage['tool']['state'] = 'completed', result?: unknown,
): ToolFixture {
    const n = seq++;
    const id = `tc-${n}`;
    const at = T0 + n * 1000;
    return {
        id, runner, title,
        message: {
            kind: 'tool-call', id, localId: null, createdAt: at, children: [],
            tool: { name, state, input, createdAt: at, startedAt: at, completedAt: state === 'running' ? null : at + 800, description: null, result },
        },
    };
}

const READ_RESULT = [
    '10\texport function resolveTitle(session: Session): string {',
    '11\t    const meta = session.metadata;',
    '12\t    if (meta?.summary?.text) return meta.summary.text;',
    '13\t    return meta?.path ? basename(meta.path) : session.id;',
    '14\t}',
].join('\n');

const WEB_SEARCH_RESULT = 'Web search results for query: "vitest snapshot inline"\n\n'
    + 'Links: [{"title":"Snapshot | Guide | Vitest","url":"https://vitest.dev/guide/snapshot"},{"title":"toMatchInlineSnapshot | API","url":"https://vitest.dev/api/expect#tomatchinlinesnapshot"},{"title":"Inline snapshots in Vitest – blog","url":"https://example.com/blog/inline-snapshots"}]\n\n'
    + '## Summary\n\nVitest supports `toMatchInlineSnapshot()`, which writes the snapshot into the test file itself.\n\n'
    + 'REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.';

const JINA_SEARCH_RESULT = 'query: tanstack virtual dynamic height\nresults:\n'
    + '  - title: Dynamic | TanStack Virtual Docs\n    url: https://tanstack.com/virtual/latest/docs/framework/react/examples/dynamic\n    snippet: Rows measured after render with measureElement.\n    date: Sep 2, 2026\n    engine: google\n'
    + '  - title: "measureElement and scroll jumps #612"\n    url: https://github.com/TanStack/virtual/issues/612\n    snippet: Scroll position jumps when items above the viewport resize.\n    engine: google\n';

const TAVILY_RESULT = JSON.stringify({
    query: 'pnpm workspace filter syntax', answer: null, images: [],
    results: [
        { url: 'https://pnpm.io/filtering', title: 'Filtering | pnpm', content: 'Filtering allows you to restrict commands to specific subsets of packages.', score: 0.91 },
        { url: 'https://pnpm.io/cli/recursive', title: 'pnpm -r, --recursive', content: 'Runs a command in every project of a workspace.', score: 0.77 },
    ],
    response_time: 1.2,
});

const CODEX_PATCH_CHANGES = {
    'src/app/title.ts': { type: 'update', unified_diff: '@@ -1,3 +1,3 @@\n export function title(s) {\n-  return s.name;\n+  return s.name ?? s.id;\n }\n' },
    'src/app/title.test.ts': { type: 'add', content: "import { title } from './title';\n\ntest('falls back to id', () => {\n  expect(title({ id: 'x' })).toBe('x');\n});\n" },
};

export const TOOL_FIXTURES: ToolFixture[] = [
    // ── Claude Code built-ins (ordered by observed frequency) ─────────────────
    fixture('claude', 'Bash', 'Bash', { command: 'pnpm -C packages/happy-web-v2 exec tsc --noEmit', description: 'Type-check the web package' }, 'completed', 'Done in 41.2s'),
    fixture('claude', 'Bash · error', 'Bash', { command: 'git push origin HEAD' }, 'error', 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled'),
    fixture('claude', 'Read', 'Read', { file_path: '/home/me/code/app/src/session/title.ts', offset: 10, limit: 5 }, 'completed', READ_RESULT),
    fixture('claude', 'Write', 'Write', { file_path: '/home/me/code/app/docs/notes.md', content: '# Notes\n\n- Title falls back to the folder name.\n' }, 'completed', 'File created successfully at: /home/me/code/app/docs/notes.md'),
    fixture('claude', 'Edit', 'Edit', { file_path: '/home/me/code/app/src/session/title.ts', old_string: '    return session.id;', new_string: '    return meta?.path ? basename(meta.path) : session.id;' }, 'completed', 'The file /home/me/code/app/src/session/title.ts has been updated successfully.'),
    fixture('claude', 'MultiEdit', 'MultiEdit', { file_path: '/home/me/code/app/src/a.ts', edits: [{ old_string: 'let a = 1', new_string: 'const a = 1' }, { old_string: 'var b', new_string: 'let b', replace_all: true }] }, 'completed', 'Applied 2 edits'),
    fixture('claude', 'Grep', 'Grep', { pattern: 'resolveTitle', path: 'src', output_mode: 'files_with_matches' }, 'completed', 'Found 3 files\nsrc/session/title.ts\nsrc/session/SessionRow.tsx\nsrc/session/title.test.ts'),
    fixture('claude', 'Glob', 'Glob', { pattern: '**/*.test.tsx', path: 'src/screens' }, 'completed', 'src/screens/a.test.tsx\nsrc/screens/b.test.tsx'),
    fixture('claude', 'TodoWrite', 'TodoWrite', { todos: [{ content: 'Inventory tool renderers', status: 'completed', activeForm: 'Inventorying' }, { content: 'Generic key/value fallback', status: 'in_progress', activeForm: 'Building fallback' }, { content: 'Screenshots light/dark', status: 'pending', activeForm: 'Taking screenshots' }] }, 'completed', 'Todos have been modified successfully.'),
    fixture('claude', 'WebSearch', 'WebSearch', { query: 'vitest snapshot inline', mode: 'standard' }, 'completed', WEB_SEARCH_RESULT),
    fixture('claude', 'WebFetch', 'WebFetch', { url: 'https://vitest.dev/guide/snapshot', prompt: 'How do inline snapshots get updated?' }, 'completed', '# Inline snapshots\n\nRun `vitest -u` to **update** inline snapshots in place.'),
    fixture('claude', 'WebFetch · 403', 'WebFetch', { url: 'https://example.com/private', prompt: 'Summarise' }, 'completed', 'The server returned HTTP 403 Forbidden.\n\nThe response body was not retrieved.'),
    fixture('claude', 'Skill', 'Skill', { skill: 'design', args: 'tool cards' }, 'completed', 'Launching skill: design'),
    fixture('claude', 'Monitor', 'Monitor', { description: 'CI run for PR #690', timeout_ms: 900000, persistent: false, command: 'until gh run view 123 --json status -q .status | grep -q completed; do sleep 30; done' }, 'completed', 'Monitor started (task bhwm3s4fz, expires in 15m unless the source ends first; you get one notice at expiry). You will be notified on each event. Keep working — do not poll or sleep.'),
    fixture('claude', 'TaskStop', 'TaskStop', { task_id: 'b1vkgxjxr' }, 'completed', '{"message":"Successfully stopped task: b1vkgxjxr (pnpm exec vite --port 5310)","task_id":"b1vkgxjxr","task_type":"local_bash","command":"pnpm exec vite --port 5310"}'),
    fixture('claude', 'SendMessage', 'SendMessage', { to: 'a8b68ab66cfca63b8', summary: 'Re-review PR 655 after fixes', message: 'Re-review request: PR #655 was updated (new head c7ea5f8e).\n\n1. ReDoS fixed\n2. Projection whitelist added' }, 'completed', mcpText('{"success":true,"message":"Resuming agent a8b68ab","resumedAgentId":"a8b68ab66cfca63b8"}')),
    fixture('claude', 'ScheduleWakeup', 'ScheduleWakeup', { delaySeconds: 1200, noop: true, prompt: 'Check the CI result and submit.', reason: 'fallback while CI runs' }, 'completed', 'Next wakeup scheduled for 00:06:00 (in 1224s).'),
    fixture('claude', 'CronCreate', 'CronCreate', { cron: '13,43 * * * *', prompt: 'Check the inbox for replies and summarise new ones.', recurring: true }, 'completed', 'Scheduled recurring job 9bcfa640 (13,43 * * * *). Session-only. Auto-expires after 7 days.'),
    fixture('claude', 'PushNotification', 'PushNotification', { message: 'CI green on PR #690', status: 'proactive' }, 'completed', 'Mobile push not sent (Remote Control inactive).'),
    fixture('claude', 'NotebookEdit', 'NotebookEdit', { notebook_path: '/home/me/nb/analysis.ipynb', cell_id: 'c3', new_source: 'df.groupby("day").size().plot()', edit_mode: 'replace' }, 'completed', 'Updated cell c3'),
    fixture('claude', 'ExitPlanMode', 'ExitPlanMode', { plan: '## Plan\n\n1. Inventory renderers\n2. Add generic key/value table\n3. Screenshots' }, 'completed', 'User approved the plan'),
    fixture('claude', 'Artifact', 'Artifact', { file_path: '/home/me/tmp/report/page.html', icon: 'checklist', description: 'Weekly triage (15 candidates)' }, 'completed', 'Published /home/me/tmp/report/page.html at https://claude.ai/artifact/E8gSTQGanrKP7uNWsd9zPy (Version 1). Stored — readable by only you.'),
    fixture('claude', 'ListAgents', 'ListAgents', {}, 'completed', 'Peer sessions (3):\n  skills-61 [c05716]  ·  interactive  ·  idle  ·  started 9h ago\n  proj-76 [058bc4]  ·  interactive  ·  idle  ·  started 16h ago\n  vh-test [25f005]  ·  interactive  ·  busy  ·  started 3d ago'),
    fixture('claude', 'Workflow', 'Workflow', { script: "export const meta = {\n  name: 'audit',\n  description: 'Audit backlog items in 4 groups',\n}\nawait parallel(groups.map(g => () => agent(prompt(g))))" }, 'completed', 'Workflow started (task wf_ab12cd). You will be notified when it completes.'),

    // ── Very Happy MCP tools not covered by the B-499 cards ───────────────────
    fixture('mcp', 'project_note', 'mcp__happy__project_note', { kind: 'decision', title: 'Phase 1: read-only inventory of three data lines', body: 'Goal: wire business data into the reporting system.\n\n- A: GPU line\n- B: API line' }, 'completed', mcpText('recorded #1')),
    fixture('mcp', 'project_context', 'mcp__happy__project_context', {}, 'completed', mcpText('not in a project')),
    fixture('mcp', 'request_human', 'mcp__happy__request_human', { reason: 'Scan the login QR code', panel: 'dev' }, 'completed', mcpText('Notified the user. This does not mean they have seen it.')),

    // ── Third-party MCP ───────────────────────────────────────────────────────
    fixture('mcp', 'jina read_url', 'mcp__jina__read_url', { url: 'https://forums.example.com/t/trust-zdr/27126', question: 'What is the concern about ZDR?' }, 'completed', mcpText('url: https://forums.example.com/t/trust-zdr/27126\ntitle: Do you trust ZDR? - Forums\ncontent: >2-\n  Curious as to the extent you trust "Zero Data Retention"? It seems a bit blurry in terms of the layers at which there is no retention.')),
    fixture('mcp', 'jina search_web', 'mcp__jina__search_web', { query: ['tanstack virtual dynamic height'] }, 'completed', mcpText(JINA_SEARCH_RESULT)),
    fixture('mcp', 'tavily_search', 'mcp__tavily__tavily_search', { query: 'pnpm workspace filter syntax', max_results: 5 }, 'completed', TAVILY_RESULT),
    fixture('mcp', 'slack search (CSV)', 'mcp__slack__conversations_search_messages', { search_query: 'quota increase', filter_in_channel: 'C0B34P2LW5C', limit: 5 }, 'completed', mcpText('MsgID,UserName,Channel,Text,Time\n1778753217.98,qiang,#ext-aws,"Quota request: Nova Lite us-east-1",2026-10-12T08:00:00Z')),
    fixture('mcp', 'todo list (JSON)', 'mcp__todo__todo_list', { project: 'inbox', limit: 3 }, 'completed', mcpText({ tasks: [{ id: '6512a', title: 'Renew passport', dueDate: '2026-11-02', priority: 3 }, { id: '6512b', title: 'Book dentist', priority: 1 }], total: 2 })),
    fixture('mcp', 'chrome-devtools error', 'mcp__chrome-devtools__new_page', { url: 'http://localhost:8799/ranking.html', isolatedContext: 'rankpreview' }, 'error', mcpText("Network.enable timed out. Increase the 'protocolTimeout' setting.")),
    fixture('mcp', 'unknown MCP, nested input', 'mcp__jira__create_issue', { project: 'VH', fields: { summary: 'Automations detail route', labels: ['web', 'ui'], priority: { name: 'High' } }, dryRun: false }, 'completed', mcpText({ key: 'VH-12', self: 'https://jira.example.com/rest/api/2/issue/10012' })),
    // ── Codex (app-server live + history import) ──────────────────────────────
    fixture('codex', 'CodexBash', 'CodexBash', { command: "rg -n 'resolveTitle' src", cwd: '/home/me/code/app', description: 'Find title helpers' }, 'completed', null),
    fixture('codex', 'CodexPatch (live record)', 'CodexPatch', { changes: {
        '/home/me/code/app/src/app/title.ts': { kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n export function title(s) {\n-  return s.name;\n+  return s.name ?? s.id;\n }\n' },
        '/home/me/code/app/src/app/title.test.ts': { kind: { type: 'add' }, add: { content: "import { title } from './title';\n\ntest('falls back to id', () => {\n  expect(title({ id: 'x' })).toBe('x');\n});\n" } },
    } }, 'completed', null),
    fixture('codex', 'CodexPatch (history array)', 'CodexPatch', { changes: Object.entries(CODEX_PATCH_CHANGES).map(([path, c]) => ({ path, kind: { type: c.type }, diff: 'unified_diff' in c ? c.unified_diff : undefined, content: 'content' in c ? c.content : undefined })), status: 'completed' }, 'completed', null),
    fixture('codex', 'McpTool (third-party)', 'McpTool', { server: 'github', tool: 'search_issues', arguments: { q: 'repo:acme/app is:open label:bug', per_page: 5 } }, 'completed', null),
    fixture('codex', 'CodexCollaboration (no threads)', 'CodexCollaboration', { operation: 'spawn_agent', prompt: 'Review the diff for regressions', model: 'gpt-5-codex', receiverThreadIds: [], agentsStates: {} }, 'error', '{"operation":"spawn_agent","prompt":"Review the diff for regressions"}'),
    fixture('codex', 'CodexDiff', 'CodexDiff', { unified_diff: '--- a/src/app/title.ts\n+++ b/src/app/title.ts\n@@ -1,3 +1,3 @@\n export function title(s) {\n-  return s.name;\n+  return s.name ?? s.id;\n }\n' }, 'completed', null),
    fixture('codex', 'CodexReasoning', 'CodexReasoning', { title: 'Comparing the two title fallbacks' }, 'completed', null),

    // ── pi / ACP (pi-acp, opencode, custom ACP agents) ───────────────────────
    fixture('pi', 'pi bash', 'execute', { piTool: 'bash', command: 'pnpm test --filter web', acpTitle: 'pnpm test --filter web', acpKind: 'execute', rawInput: { command: 'pnpm test --filter web' } }, 'completed', { text: ' Test Files  12 passed (12)\n      Tests  148 passed (148)', isError: false }),
    fixture('pi', 'pi edit', 'edit', { piTool: 'edit', acpTitle: 'edit', acpKind: 'edit', rawInput: { path: 'src/app/title.ts', edits: [{ oldText: 'return s.name;', newText: 'return s.name ?? s.id;' }] } }, 'completed', null),
    fixture('pi', 'pi unknown tool', 'other', { piTool: 'web_search', acpTitle: 'web_search', acpKind: 'other', rawInput: { query: 'acp protocol tool kinds', limit: 5 } }, 'completed', null),
    fixture('pi', 'ACP search', 'search', { items: [], locations: [{ path: '/home/me/code/app/src' }], acpTitle: "grep -n 'resolveTitle'", acpKind: 'search', rawInput: { pattern: 'resolveTitle', path: 'src' } }, 'completed', null),
    fixture('pi', 'ACP fetch', 'fetch', { items: [], acpTitle: 'Fetch https://agentclientprotocol.com/protocol/tool-calls', acpKind: 'fetch', rawInput: { url: 'https://agentclientprotocol.com/protocol/tool-calls' } }, 'completed', null),
    fixture('pi', 'ACP think', 'think', { items: [{ type: 'content', content: { type: 'text', text: 'The title helper is called from two places; only one needs the fallback.' } }], acpTitle: 'Thinking', acpKind: 'think' }, 'completed', null),
    fixture('pi', 'ACP execute (opencode)', 'execute', { items: [], acpTitle: 'npm run lint', acpKind: 'execute', rawInput: { command: 'npm run lint', description: 'Lint the app' } }, 'completed', null),

    // ── Gemini (legacy acp channel: results carry ACP content) ────────────────
    fixture('gemini', 'Gemini execute', 'execute', { toolCall: { title: 'ls -la src [cwd /home/me/code/app] (List source files)' }, locations: [], acpTitle: 'ls -la src [cwd /home/me/code/app] (List source files)', acpKind: 'execute' }, 'completed', [{ type: 'content', content: { type: 'text', text: 'total 16\ndrwxr-xr-x  4 me  staff  128 Oct 22 10:01 app\n-rw-r--r--  1 me  staff  412 Oct 22 10:01 main.ts' } }]),
    fixture('gemini', 'Gemini edit', 'edit', { locations: [{ path: '/home/me/code/app/src/main.ts' }], acpTitle: 'Writing to src/main.ts', acpKind: 'edit' }, 'completed', [{ type: 'diff', path: '/home/me/code/app/src/main.ts', oldText: "console.log('hi')\n", newText: "console.log('hello')\n" }]),
    fixture('gemini', 'Gemini read', 'read', { locations: [{ path: '/home/me/code/app/package.json' }], acpTitle: 'package.json', acpKind: 'read' }, 'completed', [{ type: 'content', content: { type: 'text', text: '{\n  "name": "app",\n  "private": true\n}' } }]),
    fixture('gemini', 'Gemini search', 'search', { locations: [], acpTitle: "'resolveTitle' within src", acpKind: 'search' }, 'completed', [{ type: 'content', content: { type: 'text', text: 'Found 2 matches\nsrc/title.ts:10\nsrc/row.tsx:44' } }]),
    fixture('gemini', 'GeminiReasoning', 'GeminiReasoning', { title: 'Planning the change' }, 'completed', { content: 'First read the helper, then add the fallback and a test.', status: 'completed' }),
    fixture('gemini', 'GeminiDiff', 'GeminiDiff', { unified_diff: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-console.log(\'hi\')\n+console.log(\'hello\')\n', path: 'src/main.ts', description: 'Greeting text' }, 'completed', { status: 'completed' }),
    fixture('gemini', 'Gemini failed tool', 'execute', { acpTitle: 'rm -rf build [cwd /home/me/code/app]', acpKind: 'execute' }, 'error', { error: 'Permission denied by user', status: 'failed' }),
];

