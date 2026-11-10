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
- 非 none 的调用不会立刻执行：它进「需要我决策」变成一张卡，回执是 \`awaiting_decision\` 和 \`approvalId\`。告诉用户一句「已放到需要我决策」，不要在聊天里再贴一遍内容。
- 用户在卡上选择后，你会收到汇报板消息；这时调 \`dispatch_approved({approvalId})\`。选「批准执行」才会派出；选「只出草稿」时不派会话，你在对话里直接给出草稿；选「放弃」就不做。
- 决策卡（key 以 \`main-agent-dispatch:\` 开头）只能由系统发出，你不能用 owner_board_* 新建、修改或关闭它；卡面被改过的批准会被拒绝（card_tampered）。

## 出站硬禁

你的会话里，任何看起来是发送、发布、部署类的工具都被禁用了（被拒时会收到原因）。这不是故障，改走上面的派活 + risk 流程。

## 回执与上限

- 写操作只回回执（≤400 字符）；列表 ≤4,000 字符、带 nextCursor；正文 ≤8,000 字符。需要更多就翻页，不要要求整段返回。
- 带 requestId 的写操作超时不等于没做：先查再重试，重试用同一个 requestId。

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
        '安全闸（硬约束）：发送 / 发布 / 部署类工具在你的会话里被禁用；派活类工具必须带 risk，非 none 会先进「需要我决策」，用户批准后用 dispatch_approved 执行。',
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
