/**
 * B-923: example main agent tool calls, one per receipt shape (success and
 * failure). Shared by the unit tests, the /dev/main-agent-tools harness and
 * the device-shell seed. Neutral local example data; ids are made up.
 * Result strings copy the CLI's real receipt formats (mainAgentTools.ts,
 * assistantTools.ts, gates/dispatchGate.ts, attention/tools.ts, B-919).
 */

import type { ToolCall } from '@/sync/typesMessage';
import { OUTBOUND_DENY_MARKER } from './mainAgentToolView';

export type ToolFixture = { id: string; title: string; tool: ToolCall };

const T0 = 1_790_000_000_000;
const LEAD = 'sess-lead-1234';
const TARGET = 'sess-target-5678';
const json = (v: unknown) => JSON.stringify(v);

function call(name: string, input: unknown, result: unknown, state: ToolCall['state'] = 'completed', extra: Partial<ToolCall> = {}): ToolCall {
    return { name: `mcp__happy__${name}`, state, input, result, createdAt: T0, startedAt: T0, completedAt: state === 'running' ? null : T0 + 1_000, description: null, ...extra };
}
const f = (id: string, title: string, tool: ToolCall): ToolFixture => ({ id, title, tool });

const DELEGATE_INPUT = { teamId: 'team-docs', goal: 'Rewrite the onboarding guide so a new user reaches a first session in five minutes.', acceptance: ['Steps tested on a fresh account', 'Screenshots use example data', 'Both languages updated'], risk: 'none', requestId: 'r-1' };

export const MAIN_AGENT_TOOL_FIXTURES: ToolFixture[] = [
    // ── teams ────────────────────────────────────────────────────────────
    f('lead_delegate-ok', 'lead_delegate · delivered', call('lead_delegate', DELEGATE_INPUT,
        json({ ok: true, as: 'owner', via: 'main-agent', teamId: 'team-docs', team: 'Docs crew', lead: 'Lead', leadSessionId: LEAD, state: 'delivered' }))),
    f('lead_delegate-running', 'lead_delegate · running', call('lead_delegate', DELEGATE_INPUT, undefined, 'running')),
    f('lead_delegate-unreachable', 'lead_delegate · lead unreachable', call('lead_delegate', DELEGATE_INPUT,
        json({ ok: false, error: 'lead_unreachable', detail: 'Team "Docs crew" has no Lead session' }), 'error')),
    f('lead_message-ok', 'lead_message · delivered', call('lead_message', { teamId: 'team-docs', body: 'Ship the guide before the screenshots; they can follow tomorrow.', taskId: 'task-42', risk: 'none' },
        json({ ok: true, as: 'owner', via: 'main-agent', teamId: 'team-docs', team: 'Docs crew', lead: 'Lead', leadSessionId: LEAD, state: 'delivered' }))),
    f('lead_message-error', 'lead_message · not found', call('lead_message', { teamId: 'team-gone', body: 'Status?', risk: 'none' },
        'Team team-gone not found (teams_list shows the account\'s teams).', 'error')),
    f('teams_list-ok', 'teams_list', call('teams_list', {},
        '2 team(s) — id name lead open-tasks project:\nteam-docs "Docs crew" lead=Lead bot=bot-1 session=sess-lead-1234 open=3\nteam-web "Web" lead=Lead bot=bot-2 session=sess-lead-9 open=1 project=proj-1')),
    f('teams_list-empty', 'teams_list · empty', call('teams_list', {}, 'no teams')),

    // ── sessions ─────────────────────────────────────────────────────────
    f('session_spawn-ok', 'session_spawn · started', call('session_spawn', { directory: '~/work/site', prompt: 'Find why the build is slow and propose a fix (no changes yet).', title: 'Build speed', agent: 'claude', risk: 'none' },
        `Spawned ${TARGET} "Build speed"; first prompt sent, working in the background (session_read later). https://example.invalid/session/${TARGET}`)),
    f('session_spawn-partial', 'session_spawn · first prompt failed', call('session_spawn', { directory: '~/work/site', prompt: 'Audit dependencies.', risk: 'none' },
        `Spawned ${TARGET}, but sending the first prompt failed (timeout); retry with session_send. https://example.invalid/session/${TARGET}`)),
    f('session_spawn-error', 'session_spawn · failed', call('session_spawn', { directory: '~/missing', prompt: 'Hello', risk: 'none' },
        'Failed to spawn session: directory does not exist', 'error')),
    f('session_send-ok', 'session_send · delivered', call('session_send', { sessionId: TARGET, text: 'Please also check the image pipeline.', risk: 'none' },
        `Message delivered to ${TARGET} "Build speed" (live)`)),
    f('session_send-error', 'session_send · not delivered', call('session_send', { sessionId: TARGET, text: 'Ping', risk: 'none' },
        `Session ${TARGET} on dev-box is offline: machine unreachable`, 'error')),
    f('session_message-ok', 'session_message · queued', call('session_message', { to: TARGET, body: 'I am editing the README; leave it for now.', risk: 'none' },
        json({ delivered: true, to: TARGET, url: `https://example.invalid/session/${TARGET}` }))),
    f('session_message-stored', 'session_message · stored', call('session_message', { to: TARGET, body: 'Read this when you are back.', risk: 'none' },
        json({ delivered: false, stored: true, status: 'offline-stored', messageId: 'm-12345', to: TARGET }))),
    f('sessions_list-ok', 'sessions_list', call('sessions_list', { limit: 20 },
        `3 session(s):\n${TARGET} "Build speed" claude idle ~/work/site\nsess-b "Release notes" claude waiting ~/work/notes\nsess-c "Refund migration" codex error ~/work/billing`)),

    // ── gate 2 ───────────────────────────────────────────────────────────
    f('session_send-awaiting', 'gate 2 · awaiting decision', call('session_send', { sessionId: TARGET, text: 'Reply to the customer thread with the fix summary.', risk: 'none' },
        json({ ok: true, state: 'awaiting_decision', approvalId: 'appr-1', boardItemId: 'item-1', risk: 'external', note: '已放到「需要我决策」，等用户选择后调 dispatch_approved' }))),
    f('lead_delegate-risk', 'gate 2 · risk missing', call('lead_delegate', { ...DELEGATE_INPUT, risk: undefined },
        json({ ok: false, error: 'risk_required', hint: 'pass risk: none | external | production' }), 'error')),
    f('session_spawn-board', 'gate 2 · board unavailable', call('session_spawn', { directory: '~/work/ops', prompt: 'Roll back the last deploy.', risk: 'production' },
        json({ ok: false, error: 'board_unavailable', risk: 'production' }), 'error')),
    f('dispatch_approved-ok', 'dispatch_approved · approved', call('dispatch_approved', { approvalId: 'appr-1' },
        json({ ok: true, state: 'dispatched', approvalId: 'appr-1', choice: 'approve', result: `Message delivered to ${TARGET}` }))),
    f('dispatch_approved-draft', 'dispatch_approved · draft only', call('dispatch_approved', { approvalId: 'appr-2' },
        json({ ok: true, state: 'draft_only', approvalId: 'appr-2', note: '用户选了只出草稿：不派会话，在对话里给出草稿' }))),
    f('dispatch_approved-dropped', 'dispatch_approved · declined', call('dispatch_approved', { approvalId: 'appr-3' },
        json({ ok: true, state: 'dropped', approvalId: 'appr-3' }))),
    f('dispatch_approved-waiting', 'dispatch_approved · still waiting', call('dispatch_approved', { approvalId: 'appr-4' },
        json({ ok: false, error: 'awaiting_decision', boardItemId: 'item-4' }), 'error')),
    f('dispatch_approved-already', 'dispatch_approved · already run', call('dispatch_approved', { approvalId: 'appr-1' },
        json({ ok: true, state: 'already_dispatched', approvalId: 'appr-1' }))),
    f('dispatch_approved-tampered', 'dispatch_approved · card changed', call('dispatch_approved', { approvalId: 'appr-5' },
        json({ ok: false, error: 'card_tampered', boardItemId: 'item-5' }), 'error')),
    f('dispatch_approved-not-approved', 'dispatch_approved · not approved', call('dispatch_approved', { approvalId: 'appr-6' },
        json({ ok: false, error: 'not_approved', boardItemId: 'item-6' }), 'error')),

    // ── gate 1 ───────────────────────────────────────────────────────────
    f('blocked-third-party', 'gate 1 · outbound tool stopped', { ...call('x', { channel: 'general', text: 'Shipping today' }, `${OUTBOUND_DENY_MARKER}或做生产写入；请用派活工具并标 risk，或出 decision 卡。`, 'error'), name: 'mcp__chat__send_message' }),
    f('blocked-permission', 'gate 1 · denied via permission', { ...call('owner_board_post', { kind: 'info', title: 'x' }, null, 'error'), permission: { id: 'p1', status: 'denied', reason: `${OUTBOUND_DENY_MARKER}或做生产写入；请用派活工具并标 risk，或出 decision 卡。` } }),

    // ── issues / todos / projects ────────────────────────────────────────
    f('issue_create-ok', 'issue_create', call('issue_create', { title: 'Search misses archived sessions', priority: 'high', labels: ['search'] },
        'created VH-12  [todo]  Search misses archived sessions  (unassigned · high · search)')),
    f('issue_assign-ok', 'issue_assign · run queued', call('issue_assign', { key: 'VH-12', assignee: { agent: 'claude' } },
        'assigned VH-12  [in_progress]  Search misses archived sessions  (claude · high); run #1 queued on claude')),
    f('issue_comment-ok', 'issue_comment', call('issue_comment', { issue: 'VH-12', body: 'Repro: archive a session, search its title.' }, 'commented on VH-12')),
    f('issue_comment-error', 'issue_comment · missing issue', call('issue_comment', { body: 'Hi' }, 'Pass issue="VH-N": the main agent does not run for an issue.', 'error')),
    f('issue_list-ok', 'issue_list', call('issue_list', {},
        'VH-12  [todo]  Search misses archived sessions  (unassigned · high)\nVH-11  [in_progress]  Dark mode contrast on badges  (claude)\nVH-9  [todo]  Export board as Markdown  (owner)')),
    f('todo_add-ok', 'todo_add', call('todo_add', { title: 'Review the onboarding guide draft', note: 'After the docs crew reports back.' }, 'added todo T-7 "Review the onboarding guide draft" v1')),
    f('todo_complete-ok', 'todo_complete', call('todo_complete', { id: 'T-7' }, 'todo T-7 is done v2')),
    f('todo_complete-error', 'todo_complete · missing', call('todo_complete', { id: 'T-99' }, 'Todo not found; it may have been deleted.', 'error')),
    f('todo_list-ok', 'todo_list', call('todo_list', {}, '2 open, 1 done:\nT-7 [open] Review the onboarding guide draft v1\nT-6 [open] Renew the test certificate v3\nT-5 [done] Book the demo room v2')),
    f('project_note-ok', 'project_note', call('project_note', { projectId: 'proj-1', kind: 'decision', title: 'Screenshots use example data only', body: 'Applies to docs and release notes.' }, 'recorded #18')),
    f('project_note-refused', 'project_note · old server', call('project_note', { projectId: 'proj-1', kind: 'finding', title: 'Build cache is cold on Mondays' },
        json({ ok: false, error: 'project_not_member', detail: 'This server does not take project notes from the main agent yet' }))),
    f('project_list-ok', 'project_list', call('project_list', {}, '1 project(s) — id name folder goal:\nproj-1 "Website" folder=dev-box:~/work/site Faster first session teams=1')),

    // ── board ────────────────────────────────────────────────────────────
    f('owner_board_post-ok', 'owner_board_post', call('owner_board_post', { kind: 'decision', title: 'Which onboarding flow ships first?', body_md: 'Both drafts are ready; the short one tested better.', options: [{ id: 'a', label: 'Short flow' }, { id: 'b', label: 'Guided tour' }] },
        json({ id: 'item-9', created: true }))),
    f('owner_board_post-reserved', 'owner_board_post · reserved card', call('owner_board_post', { kind: 'info', title: 'x', key: 'main-agent-dispatch:appr-1' },
        json({ ok: false, error: 'reserved_card', note: 'decision cards of the dispatch gate cannot be posted, edited or closed by the main agent' }), 'error')),
    f('owner_board_resolve-ok', 'owner_board_resolve', call('owner_board_resolve', { id: 'item-9', outcome: 'done', note: 'Short flow shipped.' },
        json({ item: { id: 'item-9', title: 'Which onboarding flow ships first?', state: 'resolved' } }))),
    f('owner_board_list-ok', 'owner_board_list', call('owner_board_list', { state: 'open' },
        json({ items: [{ id: 'item-9', title: 'Which onboarding flow ships first?', state: 'open' }, { id: 'item-10', title: 'Release notes ready for review', state: 'open' }] }))),

    // ── lifecycle (B-919 receipts) ───────────────────────────────────────
    f('session_wrapup-ok', 'session_wrapup · queued', call('session_wrapup', { sessionId: TARGET }, json({ ok: true, sessionId: TARGET, state: 'queued' }))),
    f('session_wrapup-running', 'session_wrapup · already wrapping up', call('session_wrapup', { sessionId: TARGET }, json({ ok: true, sessionId: TARGET, state: 'running' }))),
    f('session_wrapup-error', 'session_wrapup · refused', call('session_wrapup', { sessionId: TARGET }, json({ ok: false, sessionId: TARGET, error: 'archived session' }), 'error')),
    f('session_handoff-ok', 'session_handoff · to a new session', call('session_handoff', { from: TARGET, note: 'Continue with the image pipeline.' }, json({ ok: true, from: TARGET, to: 'fresh', state: 'queued' }))),
    f('session_handoff-to', 'session_handoff · to a session', call('session_handoff', { from: TARGET, to: LEAD }, json({ ok: true, from: TARGET, to: LEAD, state: 'done' }))),
    f('session_handoff-error', 'session_handoff · failed', call('session_handoff', { from: TARGET }, json({ ok: false, from: TARGET, to: 'new', error: 'directory missing' }), 'error')),
    f('session_restart-idle', 'session_restart · when idle', call('session_restart', { sessionId: TARGET, when: 'idle' }, json({ ok: true, sessionId: TARGET, scheduled: 'idle', targetVersion: '0.2.212' }))),
    f('session_restart-now', 'session_restart · now', call('session_restart', { sessionId: TARGET, when: 'now' }, json({ ok: true, sessionId: TARGET, scheduled: 'now' }))),
    f('session_restart-already', 'session_restart · already queued', call('session_restart', { sessionId: TARGET }, json({ ok: true, sessionId: TARGET, scheduled: 'idle', already: true }))),
    f('session_restart-busy', 'session_restart · busy', call('session_restart', { sessionId: TARGET, when: 'now' }, json({ ok: false, sessionId: TARGET, error: 'it is in the middle of a turn; use when = idle' }), 'error')),
    f('session_restart-unavailable', 'session_restart · not available', call('session_restart', { sessionId: TARGET, when: 'idle' },
        json({ ok: false, error: 'not_available', detail: 'Restart when idle is not available on this Very Happy version yet' }))),
];

export const MAIN_AGENT_TOOL_FIXTURE = (id: string): ToolCall => {
    const hit = MAIN_AGENT_TOOL_FIXTURES.find((x) => x.id === id);
    if (!hit) throw new Error(`no fixture ${id}`);
    return hit.tool;
};
