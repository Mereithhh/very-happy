import { BUILTIN_TODO_DISCOVERY } from '@/modules/todo/skill';
import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { AGENT_GUIDANCE } from "./agentGuidance";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    This chat is titled automatically from the user's first message. Call "mcp__happy__change_title" only when the topic has clearly moved on or the current title is too generic to find this chat later. Do not call it as a ritual at the start of a chat, and not for a quick question you can just answer.
`))()
    // B-493: 旧文案是「每个新对话 ALWAYS 先调 change_title」。首条标题早已由
    // titleGenerator（haiku 旁路）生成，这条硬规则让每个会话多 ToolSearch +
    // change_title 两轮；一句话问答成本 +50%（2026-09-25 A/B）。
    // B-130: 工具面行为边界。这一处同时覆盖 SDK 与 local CLI 两种模式
    // （`loop.ts` 允许用户在 web 端切换），文案与上限见 agentGuidance.ts。
    + '\n\n' + AGENT_GUIDANCE + '\n\n' + BUILTIN_TODO_DISCOVERY;

/**
 * Co-authored-by credits to append when enabled
 */
// B-493: 只在 agent 自己执行 git commit 时加署名；用户只是要一段 commit message
// 文本时加进去会污染交付物（2026-09-25 A/B 实撞）。
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When you yourself create a git commit, instead of just giving co-credit to Claude, also give credit to Happy like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)
    via [Very Happy](https://github.com/Mereithhh/very-happy)

    Co-Authored-By: Claude <noreply@anthropic.com>

    Do not add these lines to commit message text you only draft for the user.
`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return BASE_SYSTEM_PROMPT;
  }
})();
