import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { TOOL_FIXTURES } from '@/dev/toolCardFixtures';

/**
 * B-754 rendering contract: every tool shape the runners emit (Claude,
 * Codex, pi/ACP, Gemini, MCP — the fixtures mirror the CLI mappers) renders a
 * verb row and a purpose-built body; none shows a JSON block in the chat. The
 * raw payload exists only behind the collapsed 「Raw data」 disclosure.
 */
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToolGroupView } = await import('./ToolGroupView'));
});

function render(m: ToolCallMessage): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s-1']}>
            <Routes><Route path="/session/:id" element={<ToolGroupView tools={[m]} />} /></Routes>
        </MemoryRouter>,
    );
}
const byTitle = (title: string) => {
    const f = TOOL_FIXTURES.find((x) => x.title === title);
    if (!f) throw new Error(`no fixture ${title}`);
    return render(f.message);
};
/** `"key":` as it appears in escaped markup — the signature of a JSON dump. */
const JSON_KEY = /&quot;[A-Za-z_][\w-]*&quot;\s*:/;

describe('no JSON block in the chat, for every runner shape', () => {
    // The Gemini read fixture reads package.json — that JSON is the file's content, not a dump.
    const FILE_CONTENT_IS_JSON = new Set(['Gemini read']);
    it.each(TOOL_FIXTURES.map((f) => [`${f.runner} · ${f.title}`, f] as const))('%s', (_label, f) => {
        const html = render(f.message);
        expect(html).toContain('tg-tool-label');
        if (!FILE_CONTENT_IS_JSON.has(f.title)) expect(html).not.toMatch(JSON_KEY);
        expect(html).not.toContain('Input Parameters');
    });

    it('raw data is present but folded for cards that hide fields', () => {
        for (const title of ['unknown MCP, nested input', 'CodexPatch (live record)', 'Bash', 'jina search_web']) {
            const html = byTitle(title);
            expect(html).toMatch(/<div class="bt-raw" data-raw="">\s*<button[^>]*aria-expanded="false"[^>]*>.*Raw data/s);
        }
    });
});

describe('purpose-built cards', () => {
    const cases: Array<[string, string[]]> = [
        // title → markers that prove the right body rendered
        ['Bash', ['Run', 'class="cmd"', 'Done in 41.2s']],
        ['CodexBash', ['Run', 'class="cmd"', 'rg -n', '/home/me/code/app']],
        ['Gemini execute', ['Run', 'class="cmd"', 'main.ts', 'List source files'.slice(0, 0)]],
        ['pi bash', ['Run', 'class="cmd"', '148 passed']],
        ['ACP execute (opencode)', ['Run', 'npm run lint']],
        ['Read', ['Read', 'title.ts:10-14', 'class="cv cv--ln"', '--cv-ln-start:9', 'export function resolveTitle']],
        ['Gemini read', ['Read', 'package.json', '&quot;private&quot;']],
        ['Edit', ['Edit', 'class="dv']],
        ['MultiEdit', ['Edit', '2 edits']],
        ['Write', ['Write', 'notes.md', 'class="dv']],
        ['CodexPatch (live record)', ['Edit', 'title.ts', 'title.test.ts', 'class="dv']],
        ['CodexPatch (history array)', ['Edit', 'class="dv']],
        ['CodexDiff', ['Edit', 'class="dv']],
        ['GeminiDiff', ['Edit', 'class="dv']],
        ['Gemini edit', ['Edit', 'main.ts', 'class="dv']],
        ['pi edit', ['Edit', 'class="dv']],
        ['Grep', ['Search', 'resolveTitle', 'Found 3 files']],
        ['ACP search', ['Search', 'resolveTitle']],
        ['Gemini search', ['Search', 'Found 2 matches']],
        ['TodoWrite', ['Update todos', '1/3 done', 'tv-todos']],
        ['WebSearch', ['Search web', 'tv-links', 'href="https://vitest.dev/guide/snapshot"', 'toMatchInlineSnapshot()']],
        ['jina search_web', ['Search web', 'tv-links', 'measureElement and scroll jumps #612']],
        ['tavily_search', ['Search web', 'tv-links', 'Filtering | pnpm']],
        ['WebFetch', ['Fetch', 'Prompt', 'How do inline snapshots get updated?', 'Inline snapshots']],
        ['jina read_url', ['Fetch', 'Do you trust ZDR? - Forums', 'Zero Data Retention']],
        ['ACP fetch', ['Fetch', 'href="https://agentclientprotocol.com/protocol/tool-calls"']],
        ['Monitor', ['Watch', 'class="cmd"', 'Timeout ms', '900000', 'Monitor started']],
        ['ACP think', ['Think', 'tv-prose', 'only one needs the fallback']],
        ['GeminiReasoning', ['Think', 'First read the helper']],
        ['SendMessage', ['Message agent', 'tv-kv', 'Re-review request', 'Resumed agent ID']],
        ['TaskStop', ['Stop task', 'Task ID', 'Successfully stopped task']],
        ['ScheduleWakeup', ['Schedule wake-up', 'Delay seconds', '1200']],
        ['CronCreate', ['Schedule job', 'Cron', '13,43 * * * *']],
        ['PushNotification', ['Notify', 'Mobile push not sent']],
        ['Artifact', ['Publish', 'File path']],
        ['Workflow', ['Run workflow', 'audit']],
        ['project_note', ['Project note', 'Decision', 'Phase 1: read-only inventory']],
        ['project_context', ['Read project', 'not in a project']],
        ['request_human', ['Ask you to step in', 'Scan the login QR code']],
        ['todo list (JSON)', ['todo · todo_list', 'tv-kv', 'Renew passport', 'Total']],
        ['slack search (CSV)', ['slack · conversations_search_messages', 'Search query', 'quota increase']],
        ['unknown MCP, nested input', ['jira · create_issue', 'Fields › Summary', 'Fields › Priority', 'High', 'web']],
        ['McpTool (third-party)', ['github · search_issues', 'Q', 'repo:acme/app']],
        ['CodexCollaboration (no threads)', ['Codex · spawn_agent', 'Review the diff']],
        ['pi unknown tool', ['web_search', 'Query', 'acp protocol tool kinds']],
        ['chrome-devtools error', ['chrome-devtools · new_page', 'tg-error', 'Network.enable timed out']],
        ['Gemini failed tool', ['Run', 'Permission denied by user']],
    ];
    it.each(cases)('%s', (title, markers) => {
        const html = byTitle(title);
        for (const m of markers) if (m) expect(html).toContain(m);
    });
});

describe('no repeats', () => {
    const count = (html: string, needle: string) => html.split(needle).length - 1;
    it('a result that echoes the arguments is not shown as a second table', () => {
        // header detail + the argument row, not a third copy from the result
        expect(count(byTitle('CodexCollaboration (no threads)'), 'Review the diff for regressions')).toBe(2);
    });
    it('a title-only reasoning step shows its title once (the row)', () => {
        expect(count(byTitle('CodexReasoning'), 'Comparing the two title fallbacks')).toBe(1);
    });
    it('a failed command shows its error once', () => {
        expect(count(byTitle('Bash · error'), 'terminal prompts disabled')).toBe(1);
    });
});

describe('accessibility', () => {
    it('link lists are labelled, external links say they open a new tab', () => {
        const html = byTitle('WebSearch');
        expect(html).toContain('aria-label="Search results"');
        expect(html).toContain('opens in a new tab');
        expect(html).toContain('rel="noopener noreferrer"');
    });
    it('the key/value table is a labelled description list', () => {
        const html = byTitle('unknown MCP, nested input');
        expect(html).toMatch(/<dl class="bt-fields tv-kv" aria-label="Arguments">/);
        expect(html).toContain('<dt class="bt-k">');
    });
    it('disclosures expose their state', () => {
        const html = byTitle('Bash');
        expect(html).toMatch(/class="tg-row-head vh-disclosure-trigger"[^>]*aria-expanded="true"/);
        expect(html).toMatch(/class="bt-raw-head vh-disclosure-trigger"[^>]*aria-expanded="false"/);
    });
});
