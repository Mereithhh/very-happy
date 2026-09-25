/**
 * DEV-only harness for B-499 built-in tool cards. Route `/dev/builtin-tools/:id`
 * so rows see a session id (links render); `?theme=dark|light` forces a theme.
 * Every message here is a local example — nothing is sent or read from a server.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import '@/screens/session/session.css';
import '@/screens/session/chatlist.css';

const NOW = Date.now();
let seq = 0;
const text = (value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

function call(name: string, input: unknown, state: ToolCallMessage['tool']['state'] = 'completed', result?: unknown): ToolCallMessage {
    const id = `bt-${seq++}`;
    return {
        kind: 'tool-call', id, localId: null, createdAt: NOW - 60_000 + seq * 1000, children: [],
        tool: { name, state, input, createdAt: NOW - 60_000 + seq * 1000, startedAt: NOW - 60_000 + seq * 1000, completedAt: state === 'running' ? null : NOW - 59_000 + seq * 1000, description: null, result },
    };
}

const cron = { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' };
const spawn = { kind: 'spawn', agent: 'codex', directory: '/home/me/code/very-happy', prompt: 'Run the inventory script and summarise anomalies in one paragraph.' };
const automation = { id: 'auto_01HZX7Q9K2', name: 'daily-inventory', status: 'active', version: 2, trigger: cron, action: spawn, nextRunAt: NOW + 3_600_000 };
const team = { id: 'team_9f3a', name: 'release-train', bots: [{ id: 'bot-root' }, { id: 'bot-codex' }], tasks: [{ id: 'task_44', status: 'running' }], messages: [{}, {}] };

const SECTIONS: Array<{ title: string; items: ToolCallMessage[] }> = [
    { title: 'Session / clipboard / progress (Claude mcp__happy__ names)', items: [
        call('mcp__happy__change_title', { title: 'Automations page: sidebar entry and detail route' }, 'completed', text('Successfully changed chat title')),
        call('mcp__happy__copy_to_clipboard', { text: 'pnpm -C packages/happy-web-v2 exec vitest run\n'.repeat(3) }, 'completed', text('Queued a clipboard request for the user\'s open Very Happy device(s).')),
        call('mcp__happy__report_progress', { progress: 'All gates green, PR #431 open for review', attention: 'review' }, 'completed', text('Board updated.')),
        call('mcp__happy__report_progress', { progress: 'Need the Slack token before I can continue', attention: 'blocked' }, 'completed', text('Board updated.')),
        call('mcp__happy__open_preview', { path: '/home/me/code/very-happy/docs/report.md' }, 'error', text('Could not open preview: path is outside the allowed roots')),
    ] },
    { title: 'Teams', items: [
        call('mcp__happy__team_create', { name: 'release-train', requestId: 'r1' }, 'completed', text({ team, botId: 'bot-root' })),
        call('mcp__happy__team_delegate', {
            goal: 'Implement the automations page (list, detail, run history) behind /board/automations',
            acceptance: ['vitest, vite build and tsc all green', 'desktop and 390px screenshots attached', 'PR opened, not merged'],
            assistant: 'codex', directory: '/home/me/code/very-happy', requestId: 'r2',
        }, 'completed', text({ taskId: 'task_44', team })),
        call('mcp__happy__team_message', { taskId: 'task_44', body: 'Heads-up: the sidebar file is owned by the other branch — do not touch it.' }, 'completed', text({ team })),
        call('mcp__happy__team_submit', { taskId: 'task_44', attemptId: 'att_1', goalVersion: 1, result: 'Page implemented, 14 tests, screenshots in the PR.' }, 'completed', text({ taskId: 'task_44', team })),
        call('mcp__happy__team_return', { taskId: 'task_44', attemptId: 'att_1', goalVersion: 1, reason: '390px layout overflows horizontally on the run list.' }, 'completed', text({ taskId: 'task_44', team })),
        call('mcp__happy__team_schedule_create', { name: 'standup', botId: 'bot-root', body: 'Inspect the team and summarise progress.', runAt: NOW + 86_400_000, intervalMs: 86_400_000 }, 'completed', text({ scheduleId: 'sch_7', team })),
        call('mcp__happy__team_inspect', {}, 'running'),
        call('mcp__happy__team_accept', { taskId: 'task_44', attemptId: 'att_2', goalVersion: 1 }, 'error', text('Attempt att_2 is not the current attempt (goal version moved to 2)')),
    ] },
    { title: 'Automations (Codex McpTool envelope + pi piTool envelope)', items: [
        call('McpTool', { server: 'happy', tool: 'automation_create', arguments: { name: 'daily-inventory', trigger: cron, action: spawn, concurrency: 'skip', maxRuntimeMs: 3_600_000 } }, 'completed', text({ automation })),
        call('McpTool', { server: 'happy', tool: 'automation_update', arguments: { name: 'daily-inventory', version: 2, trigger: { kind: 'interval', everyMs: 7_200_000 } } }, 'completed', text({ automation: { ...automation, version: 3, trigger: { kind: 'interval', everyMs: 7_200_000 } } })),
        call('other', { piTool: 'automation_list', rawInput: {} }, 'completed', text({ automations: [automation, { ...automation, id: 'auto_02', name: 'nightly-backup', status: 'paused', trigger: { kind: 'cron', expr: '30 2 * * *', tz: 'UTC' }, action: { kind: 'script', command: ['rsync', '-a', '/data', '/backup'] } }] })),
        call('other', { piTool: 'automation_run', rawInput: { name: 'daily-inventory', payload: '{"reason":"manual check"}' } }, 'completed', text({ run: { id: 'run_01HZX8', status: 'queued', automationId: automation.id } })),
        call('mcp__happy__automation_report', { status: 'done', summary: '3 anomalies found, details in the session.' }, 'completed', text({ run: { id: 'run_01HZX8', status: 'done', summary: '3 anomalies found, details in the session.', sessionId: 'sess_abcdefgh1234' } })),
        call('mcp__happy__automation_runs', { name: 'daily-inventory', attention: true }, 'completed', text({ runs: [{ id: 'run_01HZX5', status: 'failed', error: 'machine offline for 12 min', needsAttention: true }, { id: 'run_01HZX4', status: 'done', summary: 'no anomalies' }] })),
        call('mcp__happy__automation_delete', { name: 'nightly-backup' }, 'completed', text({ deleted: true, id: 'auto_02', name: 'nightly-backup' })),
        call('mcp__happy__automation_create', { name: 'Bad Name' }, 'error', text('automation name must match [a-z0-9][a-z0-9-_.]{0,63}')),
        call('mcp__happy__automation_create', { name: 'half-stre' }, 'running'),
    ] },
    { title: 'Assistant variant (bare names)', items: [
        call('session_spawn', { directory: '/home/me/code/very-happy', prompt: 'Review PR #431 and leave comments.' }, 'completed', 'Spawned session sess_abcdefgh1234 in /home/me/code/very-happy and sent the first prompt. It is now working in the background — check on it later with session_read. https://veryhappy.dev/session/sess_abcdefgh1234'),
        call('session_send', { sessionId: 'sess_abcdefgh1234', text: 'Also run the CLI smoke test before you finish.' }, 'completed', 'Message delivered to sess_abcdefgh1234 [running] title="Review PR #431" cwd=/home/me/code/very-happy'),
        call('sessions_list', {}, 'completed', '2 session(s):\nsess_abcdefgh1234 [running] title="Review PR #431" cwd=/home/me/code/very-happy\nsess_zyxwvuts9876 [not running] title="Automations page" cwd=/home/me/code/very-happy'),
        call('terminal_send', { terminalId: 'term-3', text: 'pnpm test', submit: false }, 'completed', 'Pasted into terminal term-3 WITHOUT pressing Enter.'),
        call('memory_update', { section: 'Preferences', content: 'Owner prefers Chinese replies; PRs are never merged by agents.' }, 'completed', 'Replaced section "Preferences" in /home/me/.happy/assistant/memory/personal.md. File is now 812 chars.'),
        call('journal_append', { content: 'Opened PR #431 for B-499; waiting on CI.' }, 'completed', 'Appended to /home/me/.happy/assistant/memory/journal/2026-09-25.md.'),
    ] },
    { title: 'Unknown MCP tool (generic fallback stays)', items: [
        call('mcp__jira__create_issue', { project: 'VH', summary: 'Automations detail route' }, 'completed', text({ key: 'VH-12' })),
    ] },
];

const GROUP: ToolCallMessage[] = [
    call('mcp__happy__team_delegate', { goal: 'Write the changelog entry', acceptance: ['en + zh-Hans'], assistant: 'claude' }, 'completed', text({ taskId: 'task_45', team })),
    call('mcp__happy__team_delegate', { goal: 'Update the docs screenshots', acceptance: ['light + dark'], assistant: 'pi-acp' }, 'completed', text({ taskId: 'task_46', team })),
    call('mcp__happy__team_message', { taskId: 'task_45', body: 'Use key sep25g.' }, 'completed', text({ team })),
];

export function BuiltinToolsHarness() {
    const [params] = useSearchParams();
    const theme = params.get('theme');
    useEffect(() => {
        const el = document.documentElement;
        const previous = el.getAttribute('data-theme');
        if (theme === 'dark' || theme === 'light') el.setAttribute('data-theme', theme);
        return () => { if (previous) el.setAttribute('data-theme', previous); else el.removeAttribute('data-theme'); };
    }, [theme]);
    return (
        <div className="sd"><div className="sd-main"><div className="sd-body"><div className="cl"><div className="cl-scroll"><div className="cl-inner" data-testid="builtin-tools">
            <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-12)' }}>本地示例 · B-499 内置工具卡（数据均为伪造，不发送请求）</div>
            {SECTIONS.map((section) => (
                <section key={section.title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
                    <h2 style={{ fontSize: 'var(--fs-13)', fontWeight: 600, color: 'var(--text-dim)', margin: 'var(--sp-4) 0 0' }}>{section.title}</h2>
                    {section.items.map((m) => <ToolGroupView key={m.id} tools={[m]} />)}
                </section>
            ))}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
                <h2 style={{ fontSize: 'var(--fs-13)', fontWeight: 600, color: 'var(--text-dim)', margin: 'var(--sp-4) 0 0' }}>A run of several built-in calls (group header)</h2>
                <ToolGroupView tools={GROUP} />
            </section>
        </div></div></div></div></div></div>
    );
}
