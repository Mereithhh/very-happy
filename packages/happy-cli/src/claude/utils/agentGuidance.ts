/**
 * Agent 工具面指引 + 新工具的描述常量（B-130）。
 *
 * 两个职责，刻意放一个文件：
 *
 * 1. `AGENT_GUIDANCE` —— 拼进 `BASE_SYSTEM_PROMPT`，覆盖 happy 托管的两种模式
 *    （SDK / local CLI）。`loop.ts` 允许用户在 web 端切换模式，改这一处两者同时生效。
 *    ⚠️ 范围：**不覆盖 web 终端里手打的裸 claude**（happy 碰不到它的 argv），
 *    也不覆盖 terminal-mirror 影子会话。Owner 2026-08-17 拍板收的范围。
 *
 * 2. 工具描述常量 —— 三处 MCP 注册点（http MCP / codex-gemini-acp 的 stdio bridge /
 *    裸终端的 stdio MCP）共用，避免文案三处漂移。沿用 `clipboard/limits.ts` 的先例。
 *
 * 分工纪律：**system prompt 只写判断边界，tool description 只写用法**。
 * 用法写两遍等于花两份 token 说一件事，而且两处必然漂移。指引每个会话无条件进
 * context，所以有 `GUIDANCE_MAX_CHARS` 上限 + 单元测试钉死。
 */

import { trimIdent } from '@/utils/trimIdent';

/** 指引文本的字符上限——它每个会话无条件进 context，必须有个天花板。 */
export const GUIDANCE_MAX_CHARS = 1200;

/**
 * 工具面的行为边界。刻意写成判断依据而不是命令式规则：
 * 写成「必须调 X」会让 claude 在不合适的场合硬调（用户只问「这文件里有什么」
 * 就弹预览），那比不调更烦人。
 */
export const AGENT_GUIDANCE = (() => trimIdent(`
    You are running inside Happy: the user is reading this session in a web client (often a phone), NOT in the terminal where you run. Two consequences:

    - Terminal output is not a good delivery channel. When the user asks for a piece of text ("copy that", "give me X", "复制给我", "发我"), hand it over with mcp__happy__copy_to_clipboard instead of printing it for them to select by hand.
    - When you produce or want to show a FILE (a document you wrote, a report, an image, a PDF, a diff), call mcp__happy__open_preview with its path instead of cat-ing it. Their client opens the rendered file.

    Judgement, not reflex: use these when the user's goal is to RECEIVE something. If they are asking a question you can just answer, answer it. Do not preview a file you only read for your own reasoning, and do not preview the same file repeatedly within a turn.

    If you are working on a task the user is tracking, call mcp__happy__report_progress at meaningful milestones (started / blocked / needs review / done) so their board reflects reality. Do not report every tool call.
`))();

/** 剪贴板工具的描述在 `@/clipboard/limits`（先于本文件存在，不搬动以免改动面扩大）。 */

//
// open_preview（B-131）
//

export const PREVIEW_TOOL_NAME = 'open_preview';
export const PREVIEW_TOOL_TITLE = 'Open File Preview for the User';
export const PREVIEW_TOOL_DESCRIPTION =
    'Open a file in the preview panel of every web client the user currently has open. '
    + 'Use this whenever you produce or want to show the user a file: a document or report you just wrote, '
    + 'a generated image or diagram, a PDF, a data file, or a source file you want them to look at. '
    + 'Trigger phrases include: "write me a doc", "show me that file", "let me see it", '
    + '"写个文档", "给我看看这个文件", "打开看下". '
    + 'Pass an absolute path (or one starting with ~). The file is read on this machine and rendered in their browser — '
    + 'markdown is rendered, images and PDFs are displayed, other text is syntax-highlighted. '
    + 'Prefer this over printing file contents to the terminal, which the user is probably not looking at. '
    + 'NOTE: this only requests that their client open the file; it cannot confirm the user actually looked at it, '
    + 'so do not assume they have seen it.';

//
// report_progress（B-132）
//

export const REPORT_PROGRESS_TOOL_NAME = 'report_progress';
export const REPORT_PROGRESS_TOOL_TITLE = 'Report Progress to the Task Board';
export const REPORT_PROGRESS_TOOL_DESCRIPTION =
    "Report what you are doing to the user's task board, so they can see the state of this session at a glance "
    + 'without reading the transcript. '
    + 'Call it at meaningful milestones only: when you start substantive work, when you get blocked and need the user, '
    + 'when something is ready for their review, and when you are done. '
    + 'Do NOT call it after every tool call or every file edit — it is a status line, not a log. '
    + 'Set attention to "blocked" when you cannot proceed without the user, "review" when you want them to look at '
    + 'something, and "none" for ordinary progress. '
    + 'Keep progress to one short line describing the current state (the user reads it on a card).';
