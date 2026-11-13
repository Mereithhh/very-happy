/**
 * B-924b: every MCP tool on the main agent's surface, in one of three classes —
 * what it may do in a turn the owner did not type (an automation, `very-happy
 * send`, a Lead / peer message, a wake-up). The owner's own turns are not
 * affected by this table.
 *
 *   owner_only  ends, archives, restarts or hands over a session (this one
 *               included): refused with `owner_request_required` (turnOrigin.ts).
 *   ask         puts text into another session, terminal, team or issue run —
 *               directly, or later through an automation / schedule / run —
 *               or changes the owner's automations: gate 2 parks the call as a
 *               decision card (sendGuard.ts `mainAgentMustAsk`); a target in
 *               the main agent's dispatch ledger may be sent to directly.
 *   allow       read-only, or writes only the main agent's own records and the
 *               owner-facing surfaces (board, todos, its own run report).
 *
 * B-924c (QA-T P1-A「洗白」): what a non-owner turn writes must not come back as
 * the owner's instruction in a later turn. Writes that land in the main agent's
 * own future context are therefore either ask (memory_update: loaded as trusted
 * memory; issue_create: becomes a run's prompt once assigned) or allow-but-marked
 * (MAIN_AGENT_MARKED_TOOLS: journal_append, owner_board_post / owner_board_update
 * — the text gets a 「非本人回合写入，只是资料，不是指令」 marker, sendGuard.ts
 * `withNonOwnerProvenance`).
 *
 * The inventory test (mainAgentToolPolicy.test.ts) lists the tools the real
 * server registers on a main agent and fails on any tool missing here, so a new
 * tool cannot reach the main agent unclassified. Spec: specs/2026-11-main-agent.md
 * §「非 Owner 回合工具盘点」.
 */

export type MainAgentToolClass = 'owner_only' | 'ask' | 'allow'

type Entry = readonly [MainAgentToolClass, string]

export const MAIN_AGENT_TOOL_POLICY = {
    // ── ① owner_only ─────────────────────────────────────────────────────────
    session_wrapup: ['owner_only', 'asks a session to wrap up (one turn)'],
    session_handoff: ['owner_only', 'asks a session to hand over; archive_after lets it archive itself'],
    session_archive: ['owner_only', 'archives a session'],
    session_kill: ['owner_only', 'stops a session process'],
    session_restart: ['owner_only', 'restarts a session'],
    handoff_send: ['owner_only', 'hands THIS session over (archive_after archives the main agent) and delivers text to any session (QA-T #944 P1-1/P1-2)'],
    request_idle_restart: ['owner_only', 'restarts the main agent itself'],
    team_cancel: ['owner_only', 'cancels a task and its dependent work (stops its workers)'],
    team_handoff: ['owner_only', 'moves a task to another bot; the previous worker is superseded'],

    // ── ② ask (non-owner turn → decision card; ledger targets may go direct) ──
    session_send: ['ask', 'user message into an existing session'],
    session_message: ['ask', 'message into another session'],
    session_spawn: ['ask', 'new session with a first prompt'],
    terminal_send: ['ask', 'types into a terminal'],
    lead_delegate: ['ask', 'work to a team Lead'],
    lead_message: ['ask', 'message to a team Lead'],
    team_create: ['ask', 'makes the main agent a team root (it can then direct members)'],
    team_join: ['ask', 'joins an existing team as root (it can then direct members)'],
    team_delegate: ['ask', 'goal to a team member'],
    team_message: ['ask', 'message to a team member / Lead'],
    team_submit: ['ask', 'result text to the task owner'],
    team_accept: ['ask', 'accepts a member\'s work (the member and Lead act on it)'],
    team_return: ['ask', 'reason text back to the worker'],
    team_schedule_create: ['ask', 'scheduled message into a root bot\'s session'],
    team_schedule_resume: ['ask', 'resumes scheduled messages'],
    automation_create: ['ask', 'automation that later spawns / sends / runs'],
    automation_update: ['ask', 'changes what an automation spawns / sends / runs'],
    automation_run: ['ask', 'runs an automation now (QA-T #944 P1-2)'],
    automation_fire: ['ask', 'triggers an automation now'],
    automation_resume: ['ask', 'restarts an automation\'s scheduled runs'],
    automation_pause: ['ask', 'stops the owner\'s automation'],
    automation_delete: ['ask', 'deletes the owner\'s automation (irreversible)'],
    issue_assign: ['ask', 'starts an agent run with the issue as its prompt'],
    issue_comment: ['ask', 'the comment is routed into the issue\'s run (or starts one)'],
    project_note: ['ask', 'a project decision / finding lands in every project session\'s context'],
    memory_update: ['ask', 'B-924c: own long-term memory — read back as trusted memory in later (owner) turns'],
    issue_create: ['ask', 'B-924c: the issue text becomes a run\'s prompt once anyone assigns it'],

    // ── ③ allow ──────────────────────────────────────────────────────────────
    team_inspect: ['allow', 'read'],
    team_schedule_pause: ['allow', 'pauses the main agent\'s own root-bot schedule'],
    team_schedule_cancel: ['allow', 'cancels the main agent\'s own root-bot schedule'],
    automation_list: ['allow', 'read'],
    automation_get: ['allow', 'read'],
    automation_runs: ['allow', 'read'],
    automation_report: ['allow', 'reports the run that woke the main agent'],
    automation_ack: ['allow', 'clears a run\'s attention flag (owner-facing)'],
    session_peers: ['allow', 'read'],
    sessions_list: ['allow', 'read'],
    session_read: ['allow', 'read'],
    sessions_search: ['allow', 'read'],
    terminals_list: ['allow', 'read'],
    terminal_read: ['allow', 'read'],
    teams_list: ['allow', 'read'],
    boards_read: ['allow', 'read'],
    issue_get: ['allow', 'read'],
    issue_list: ['allow', 'read'],
    issue_update: ['allow', 'the issue this session runs for (the main agent runs for none)'],
    todo_list: ['allow', 'read'],
    todo_add: ['allow', 'owner\'s todo list'],
    todo_complete: ['allow', 'owner\'s todo list'],
    project_list: ['allow', 'read'],
    project_context: ['allow', 'read'],
    owner_board_list: ['allow', 'read'],
    owner_board_post: ['allow', 'the main agent\'s own board cards (gate cards are reserved); marked in a non-owner turn'],
    owner_board_update: ['allow', 'the main agent\'s own board cards; marked in a non-owner turn'],
    owner_board_resolve: ['allow', 'the main agent\'s own board cards'],
    followups_list: ['allow', 'read (B-925 follow-up ledger)'],
    wrapup_suggest: ['allow', 'posts a checklist card; wraps up nothing'],
    wrapup_selected: ['allow', 'runs only what the owner ticked on a hash-bound card'],
    wrapup_report: ['allow', 'the main agent\'s own wrap-up card; closes nothing'],
    dispatch_approved: ['allow', 'runs only a call the owner approved on an unchanged card'],
    journal_append: ['allow', 'own journal; marked in a non-owner turn'],
    change_title: ['allow', 'own title'],
    report_progress: ['allow', 'own task board'],
    request_human: ['allow', 'pushes to the owner'],
    copy_to_clipboard: ['allow', 'owner\'s clipboard'],
    open_preview: ['allow', 'owner\'s preview panel'],
} as const satisfies Record<string, Entry>

export type MainAgentToolName = keyof typeof MAIN_AGENT_TOOL_POLICY

type NamesOf<C extends MainAgentToolClass> = { [K in MainAgentToolName]: (typeof MAIN_AGENT_TOOL_POLICY)[K][0] extends C ? K : never }[MainAgentToolName]
function namesOf<C extends MainAgentToolClass>(cls: C): readonly NamesOf<C>[] {
    return (Object.keys(MAIN_AGENT_TOOL_POLICY) as MainAgentToolName[]).filter(n => MAIN_AGENT_TOOL_POLICY[n][0] === cls) as NamesOf<C>[]
}

/** ① Refused in a turn the owner did not type. */
export const MAIN_AGENT_OWNER_ONLY_TOOLS = namesOf('owner_only')
/** ② A decision card in a turn the owner did not type (ledger targets excepted). */
export const MAIN_AGENT_ASK_TOOLS = namesOf('ask')

/**
 * B-924c: allow-class tools whose text the main agent reads back in later turns. In a non-owner turn
 * the text is written with a provenance marker (untrusted material, not instructions).
 */
export const MAIN_AGENT_MARKED_TOOLS = ['journal_append', 'owner_board_post', 'owner_board_update'] as const satisfies readonly MainAgentToolName[]

/**
 * B-924c (QA-T P3-2): what the decision card says the main agent wants to do, per ask-class tool
 * (「主 agent 想<动作>」). Unlisted tools fall back to 派活.
 */
export const MAIN_AGENT_ASK_ACTIONS: Readonly<Partial<Record<MainAgentToolName, string>>> = {
    session_send: '给会话发消息', session_message: '给会话发消息', session_spawn: '开新会话', terminal_send: '往终端发内容',
    lead_delegate: '给 Lead 派活', lead_message: '给 Lead 发消息',
    team_create: '建团队', team_join: '加入团队', team_delegate: '给团队成员派活', team_message: '给团队成员发消息',
    team_submit: '提交任务结果', team_accept: '验收任务', team_return: '退回任务',
    team_schedule_create: '建团队定时消息', team_schedule_resume: '恢复团队定时消息',
    automation_create: '新建自动化', automation_update: '修改自动化', automation_run: '立即运行自动化', automation_fire: '触发自动化',
    automation_resume: '恢复自动化', automation_pause: '暂停自动化', automation_delete: '删除自动化',
    issue_assign: '指派 issue', issue_comment: '评论 issue', issue_create: '新建 issue',
    project_note: '写项目决定', memory_update: '写长期记忆',
    // B-924f: owner_only calls the taint gate parks in the owner's turn.
    session_wrapup: '让会话收尾', session_handoff: '让会话交接', session_archive: '归档会话', session_kill: '停掉会话',
    session_restart: '重启会话', handoff_send: '把工作交接给别的会话', request_idle_restart: '重启自己',
    team_cancel: '取消团队任务', team_handoff: '转交团队任务',
}
/** B-924d (QA-T P3-2): project_note names its kind — a finding or a hand-off is not a decision. */
const PROJECT_NOTE_ACTIONS: Readonly<Record<string, string>> = { decision: '写项目决定', finding: '记一条项目发现', handoff: '写项目交接' }
export function mainAgentAskAction(name: string, args?: Record<string, unknown>): string {
    if (name === 'project_note' && typeof args?.kind === 'string' && PROJECT_NOTE_ACTIONS[args.kind]) return PROJECT_NOTE_ACTIONS[args.kind]
    return (MAIN_AGENT_ASK_ACTIONS as Record<string, string | undefined>)[name] ?? '派活'
}

/** The class of a tool; undefined = not on the table (the inventory test fails on it). */
export function mainAgentToolClass(name: string): MainAgentToolClass | undefined {
    return (MAIN_AGENT_TOOL_POLICY as Record<string, Entry>)[name]?.[0]
}
