/**
 * Main agent gate 2 — risk levels and the re-check (B-916c, spec §4.2).
 *
 * Dispatch tools carry a declared `risk`. Before anything is handed to another
 * executor the tool layer re-checks the text it would hand over with a
 * keyword table (sync, no network) and a one-shot haiku classifier; the
 * highest of the three wins. Neither re-check can LOWER a level, and a failed
 * classifier never downgrades — it simply does not raise.
 */

export const RISK_LEVELS = ['none', 'external', 'production'] as const
export type RiskLevel = typeof RISK_LEVELS[number]

const RANK: Record<RiskLevel, number> = { none: 0, external: 1, production: 2 }

export function isRiskLevel(value: unknown): value is RiskLevel {
    return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
}

export function maxRisk(...levels: Array<RiskLevel | null | undefined>): RiskLevel {
    let best: RiskLevel = 'none'
    for (const level of levels) if (level && RANK[level] > RANK[best]) best = level
    return best
}

/**
 * Keyword re-check. Deliberately broad: a false "external" costs one board
 * click, a missed one costs a message the owner never saw.
 */
const PRODUCTION_PATTERNS: readonly RegExp[] = [
    /生产(环境|库|数据|集群|机器|主机)?/, /线上(环境|库|数据)/, /上线/, /发版/, /发布到/, /部署到?/, /回滚/, /灰度/, /切流/,
    /\bprod(uction)?\s+(db|database|cluster|server|host|env|environment|data)\b/i, /\bdeploy/i, /\brollback\b/i,
    /\bnpm\s+publish\b/i, /\bkubectl\s+(apply|delete|patch|scale|rollout|edit)\b/i, /\bterraform\s+apply\b/i,
]
const EXTERNAL_PATTERNS: readonly RegExp[] = [
    /发(给|个|条|一条|一下)?(消息|信息|邮件|短信|通知)/, /发给/, /转发/, /私信/, /群里/, /在群/,
    /回复(他|她|他们|对方|同事|客户|群|一下他|一下她)/, /告诉(他|她|他们|大家|对方)/, /通知(他|她|他们|大家|对方)/,
    /抄送/, /邮件/, /发评论/, /评论一下/, /对外/, /分享(链接)?给/,
    /\bsend\s+(a\s+|an\s+|the\s+)?(message|email|mail|dm|sms|reply|note)\b/i, /\bsend\s+(it\s+)?to\b/i, /\breply\s+to\b/i,
    /\bemail\b/i, /\bmessage\s+(him|her|them)\b/i, /\bpost\s+(it\s+)?(to|in|on)\b/i, /\btweet/i,
    /\bgit\s+push\b/i, /\bopen\s+(a\s+)?(pr|pull request)\b/i, /\bgh\s+(pr|issue)\s+(create|comment|merge)\b/i,
    /\bmerge\s+(the\s+)?(pr|pull request)\b/i, /\bpublish/i,
]

export function keywordRisk(text: string): RiskLevel {
    if (!text) return 'none'
    if (PRODUCTION_PATTERNS.some(re => re.test(text))) return 'production'
    if (EXTERNAL_PATTERNS.some(re => re.test(text))) return 'external'
    return 'none'
}

export const CLASSIFIER_INPUT_CHARS = 2_000

export function buildRiskClassifierPrompt(toolName: string, payload: string): string {
    return [
        'You classify one instruction that an assistant is about to hand to another agent.',
        'Answer with exactly one word:',
        '- external: the instruction makes the other agent send or publish something outside this app that other people can see (chat/IM messages, email, SMS, comments, pull requests or issues on a code host, git push to a shared remote, package publish, public share links).',
        '- production: it writes production data or infrastructure (production database, Kubernetes, cloud resources, deploy, rollback, global installs on a production host).',
        '- none: anything else (reading, investigating, drafting without sending, local code changes and tests).',
        'If both external and production apply, answer production. If unsure between none and another, answer the other.',
        `Tool: ${toolName}`,
        'Instruction:',
        '"""',
        payload.slice(0, CLASSIFIER_INPUT_CHARS),
        '"""',
        'Answer (one word):',
    ].join('\n')
}

/** First risk word in the classifier output, or null when it said something else. */
export function parseRiskClassifierOutput(output: string | null | undefined): RiskLevel | null {
    if (typeof output !== 'string') return null
    const match = output.toLowerCase().match(/\b(none|external|production)\b/)
    return match ? match[1] as RiskLevel : null
}

export type OneShotRunner = (prompt: string) => Promise<string | null>

/** haiku re-check. Null on timeout, failure or garbage (callers keep the other levels). */
export async function classifyRisk(toolName: string, payload: string, run: OneShotRunner, timeoutMs = 20_000): Promise<RiskLevel | null> {
    if (!payload.trim()) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const output = await Promise.race([
            run(buildRiskClassifierPrompt(toolName, payload)),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
        ])
        return parseRiskClassifierOutput(output)
    } catch {
        return null
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** Declared + keyword + classifier → the level the gate acts on. */
export async function effectiveRisk(input: { toolName: string; declared: RiskLevel; payload: string; classify?: OneShotRunner | null }): Promise<{ level: RiskLevel; keyword: RiskLevel; classifier: RiskLevel | null }> {
    const keyword = keywordRisk(input.payload)
    // Skip the model call when the cheap checks already reached the top level.
    const classifier = maxRisk(input.declared, keyword) === 'production' || !input.classify
        ? null
        : await classifyRisk(input.toolName, input.payload, input.classify)
    return { level: maxRisk(input.declared, keyword, classifier), keyword, classifier }
}
