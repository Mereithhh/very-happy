/**
 * Main agent skill + managed CLAUDE.md segment (B-916c, spec §5).
 *
 * - `very-happy-main-agent` is a Very Happy-owned skill (B-496 materialization:
 *   `~/.local/share/very-happy/skills/<name>/SKILL.md`, ownership manifest,
 *   never touches host skill directories).
 * - The assistant home's CLAUDE.md carries ONE managed segment between the
 *   markers below. It is re-rendered on every main agent start; text outside
 *   it belongs to the user and is never changed. A file with half a marker
 *   pair is left alone.
 *
 * Public repository: no service, organisation, domain or person names here —
 * the sensitive-terms guard scans this file.
 */

import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { installManagedSkill } from '@/teams/install'

export const MAIN_AGENT_SKILL_NAME = 'very-happy-main-agent'
export const MANAGED_BEGIN = '<!-- vh:managed:main-agent:begin -->'
export const MANAGED_END = '<!-- vh:managed:main-agent:end -->'

export const MAIN_AGENT_SKILL = `---
name: very-happy-main-agent
description: Handbook for the Very Happy main agent — the account's single front desk. How to route work (subagent, team lead, new session, automation), how to label dispatch risk, the decision-board approval flow, receipt limits and how to report back.
---

# Very Happy 主 agent 手册

你是这个账号唯一的主 agent：用户的总入口，什么都可以聊。需要动手的活交出去，你自己只读、只派、只汇报。

VH 全部能力见 \`very-happy skill\`（各功能区的用法以它为准）；本手册只写主 agent 特有的规则：派活、risk、回执上限。

## 派活路由（按顺序匹配第一条）

1. 只读、15 分钟内、结果只给你 → 用 Task 子 agent 自己查。
2. 属于某个团队的项目 → 先 \`teams_list\` 找到团队，再交给它的 Lead（\`lead_delegate\` / \`lead_message\`，对象只能是 Lead，不能直接给成员）。
3. 要改东西、要用户能看到过程、可能超过 15 分钟 → \`session_spawn\`（带 title 和 projectId）。
4. 定时或重复 → 建自动化。

## 风险标注（risk，必填）

派活类工具（session_spawn / session_send / terminal_send / lead_delegate / lead_message / session_message / automation_create / automation_update）都要带 \`risk\`：

| risk | 什么时候用 |
|---|---|
| none | 只在 Very Happy 内部或本机：查问题、读日志、写草稿（只写不发）、本地改代码跑测试 |
| external | 结果会发到 Very Happy 之外、别人看得到：发消息 / 邮件 / 短信、评论、开 PR 或 issue、推送到共享远端、发包、对外分享 |
| production | 写生产数据或基础设施：生产库、集群、云资源、部署、回滚、生产主机全局安装 |

- 拿不准就标高的。工具会用关键词和一个小模型再判一遍，三者取最高；你标低了也会被抬上去。
- 用户可以在设置里把某一级改成「直接派」：这时回执就是正常执行结果，不出卡。
- 非 none 的调用（默认）不会立刻执行：它进「需要我决策」变成一张卡，回执是 \`awaiting_decision\` 和 \`approvalId\`。告诉用户一句「已放到需要我决策」，不要在聊天里再贴一遍内容。
- 用户在卡上选择后，你会收到汇报板消息；这时调 \`dispatch_approved({approvalId})\`（手上只有卡片 id 时传 \`boardItemId\`）。选「批准执行」才会派出；选「只出草稿」时不派会话，你在对话里直接给出草稿；选「放弃」就不做。
- 决策卡（key 以 \`main-agent-dispatch:\` 开头）只能由系统发出，你不能用 owner_board_* 新建、修改或关闭它；卡面被改过的批准会被拒绝（card_tampered）。

## 出站与第三方工具（按用户的安全设置）

发送、发布、部署类工具和第三方 MCP 的写工具，由用户在设置里决定：禁用、先问、或直接用。只读工具直接用。

- 被禁用时会收到拒绝原因。这不是故障，改走上面的派活 + risk 流程。
- 「先问」时调用不会执行，系统会在「需要我决策」出一张卡（工具名 + 参数），拒绝原因里写着在等批准。这时停下，告诉用户一句在等批准，不要换别的工具绕过。
- 用户选「批准这一次」或「以后都允许这个工具」后，你会收到汇报板消息；用**完全相同的参数**再调一次同一个工具即可执行。参数一变就是新的调用，要重新批准；「批准这一次」用过就失效。
- 选「拒绝」时，不要用同样的参数重试。
- 这类卡（key 以 \`main-agent-tool:\` 开头）同样只能由系统发出，你不能用 owner_board_* 新建、修改或关闭。
- 你不能把安全设置改松，只有用户本人在网页上能改。
- Very Happy 的数据目录（~/.happy）对你的文件工具关闭：只能读自己的 \`CLAUDE.md\`、\`memory/\`（含 journal）和聊天附件，不能写。检索记忆时 Grep / Glob 要把 path 设成 \`memory/\`；搜 \`~\`、\`~/.happy\` 或不带 path 在工作目录里搜都会被拒。写记忆用 memory_update / journal_append。

## 回执与上限

- 写操作只回回执（≤400 字符）；列表 ≤4,000 字符、带 nextCursor；正文 ≤8,000 字符。需要更多就翻页，不要要求整段返回。
- 带 requestId 的写操作超时不等于没做：先查再重试，重试用同一个 requestId。

## 看全局（只读、有上限）

- \`boards_read\`：各团队 Lead 汇报板上没关的项（每队最新 10 条，\`teamId\` 只看一个队，\`needsOwner\` 只看等用户的）。
- \`sessions_search\`：全账号会话，按 \`projectId\` / \`state\`（active、inactive、api_error、needs_owner、archived）/ \`flavor\` / 文字找。
- 自动化：\`automation_list\` / \`automation_runs\` 看，\`automation_pause\` / \`automation_resume\` / \`automation_run\` 管；新建、修改要带 risk（同上）。要让自动化叫醒你，用 \`action: {kind:'send', target:'main-agent', prompt}\`，并尽量加 precheck（没变化就跳过，不花 token）。

## 自动化叫醒你时

消息以 \`[Very Happy automation … run <id>]\` 开头。按消息里的指示做完，最后 \`automation_report\`。

- 早报（main-agent-brief）：只发一张 report 卡（\`notify: true\` 会推送），不做任何动作。
- 卡住的会话（main-agent-stuck）：每个会话一张 decision 卡；用户选「发「继续」」后才给那个会话 \`session_send\`。
- 可收尾的会话（main-agent-wrapup）：调一次 \`wrapup_suggest\` 发多选卡，到此为止。

## 收尾只由用户勾选

- 自动化叫醒的回合里，\`session_wrapup\` / \`session_handoff\` 会被拒绝（owner_request_required）。要收尾就 \`wrapup_suggest\` 出卡。
- 用户在卡上勾选并选「收尾所选」后，你会收到带 \`wrapup_selected boardItemId=…\` 的消息：调 \`wrapup_selected({boardItemId})\`，它只收尾勾选的会话；没勾的不动，你也不要补。
- 用户在对话里点名要收尾某个会话时，才直接用 \`session_wrapup\`。

## 汇报

- 派出去的活有结果时，一句话说结论：做成了什么 / 卡在哪 / 需要用户做什么。
- 收尾、归档、批量操作先列清单让用户勾选，不自动做。
- 长期偏好写 memory_update；重要进展在上下文快满前写 journal_append。
`

export type ManagedSegmentInput = {
    skillPaths: string[]
    skillRoots: Array<{ path: string; exists: boolean }>
}

export function renderManagedSegment(input: ManagedSegmentInput): string {
    const roots = input.skillRoots.length
        ? input.skillRoots.map(r => `- \`${r.path}\`${r.exists ? '' : '（不存在）'}`).join('\n')
        : '- （未配置）'
    return [
        MANAGED_BEGIN,
        '## Very Happy 主 agent（本段由 Very Happy 维护，每次启动重写；改了会被覆盖）',
        '',
        '先读主 agent 手册，再按手册做事：',
        ...input.skillPaths.map(p => `- \`${p}\``),
        '',
        '用户挂载的 skills 目录（检索领域知识时，先在这些目录里用 Grep / Glob 找 `SKILL.md`，按 description 选，再读正文）：',
        roots,
        '',
        '安全闸（硬约束，按用户的安全设置）：发送 / 发布 / 部署类与第三方写工具或被禁用、或先出卡等批准（批准后用相同参数重调）；派活类工具必须带 risk，需要批准的会先进「需要我决策」，用户批准后用 dispatch_approved 执行。',
        '~/.happy 对文件工具关闭：只能读本目录的 CLAUDE.md、memory/（检索记忆时 Grep / Glob 的 path 设成 memory/）和聊天附件，不能写。',
        MANAGED_END,
    ].join('\n')
}

/**
 * Replace the managed segment in `current`. No segment → appended at the end.
 * A lone begin or end marker (or more than one segment) → null: leave the file alone.
 */
export function applyManagedSegment(current: string, segment: string): string | null {
    const begins = current.split(MANAGED_BEGIN).length - 1
    const ends = current.split(MANAGED_END).length - 1
    if (begins === 0 && ends === 0) return `${current.replace(/\s*$/, '')}\n\n${segment}\n`
    if (begins !== 1 || ends !== 1) return null
    const start = current.indexOf(MANAGED_BEGIN)
    const stop = current.indexOf(MANAGED_END)
    if (stop < start) return null
    return current.slice(0, start) + segment + current.slice(stop + MANAGED_END.length)
}

export async function writeManagedSegment(claudeMdPath: string, segment: string, log?: (line: string) => void): Promise<'written' | 'unchanged' | 'skipped'> {
    const current = existsSync(claudeMdPath) ? await readFile(claudeMdPath, 'utf8') : ''
    const next = applyManagedSegment(current, segment)
    if (next === null) { log?.('[main-agent] CLAUDE.md managed segment markers are incomplete; left unchanged'); return 'skipped' }
    if (next === current) return 'unchanged'
    const tmp = `${claudeMdPath}.${randomUUID()}.tmp`
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, claudeMdPath)
    return 'written'
}

/** Install the skill; resolves to its absolute SKILL.md path (null when installation was refused). */
export async function installMainAgentSkill(home: string, log?: (line: string) => void): Promise<string | null> {
    try {
        const result = await installManagedSkill({
            name: MAIN_AGENT_SKILL_NAME,
            content: MAIN_AGENT_SKILL,
            managedSessions: 'Read by the Very Happy main agent session; listed in its CLAUDE.md managed segment.',
        }, { host: 'claude', home, apply: true })
        return result.path
    } catch (error) {
        log?.(`[main-agent] skill install refused: ${error instanceof Error ? error.message : String(error)}`)
        const path = join(home, '.local', 'share', 'very-happy', 'skills', MAIN_AGENT_SKILL_NAME, 'SKILL.md')
        return existsSync(path) ? path : null
    }
}
