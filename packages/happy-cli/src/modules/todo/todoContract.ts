/**
 * 外部 todo provider 的契约层（B-007）—— 纯函数，零 I/O。
 *
 * very-happy 对「滴答清单」「Tanka」这类具体服务**一无所知**（本项目计划开源）。
 * 它只知道：用户配了一条命令，按 `docs/channels.md` 的契约吐 JSON。这个文件负责把
 * 那份 JSON 规范化成 UI 能用的形状，并且对畸形输入**只丢弃不抛错**——一个坏条目不该
 * 让整个面板变白。
 *
 * 契约（详见 docs/channels.md）：
 *   <command> [args...] list              → { "items": [ … ] } on stdout
 *   <command> [args...] complete <id>     → 退出码即结果，输出不解析
 *   <command> [args...] create <title>    → 同上
 *
 * 条目里只有 `id` 与 `title` 是必填，其余可选；**未知字段一律忽略**（前向兼容：
 * 第三方 provider 加字段不该让旧客户端报错）。
 */

/** 一次 list 最多返回多少条——外部系统可能有几千条，UI 和 relay 都不该吃全量。 */
export const TODO_LIST_MAX_ITEMS = 500;

/** 单条字段的字符上限（标题来自外部系统，是不可信输入）。 */
export const TODO_TITLE_MAX_CHARS = 500;
const FIELD_MAX_CHARS = 200;

export type TodoStatus = 'open' | 'done';
export type TodoPriority = 'none' | 'low' | 'medium' | 'high';

export interface TodoItem {
    id: string;
    title: string;
    status: TodoStatus;
    due?: string;
    priority?: TodoPriority;
    group?: string;
    note?: string;
}

export interface TodoListParse {
    items: TodoItem[];
    /** 被丢弃的条目数——UI 显示出来，免得用户以为东西丢了却没人告诉他。 */
    dropped: number;
    /** 是否因为超过上限被截断。 */
    truncated: boolean;
}

const PRIORITIES: readonly TodoPriority[] = ['none', 'low', 'medium', 'high'];

function str(value: unknown, max = FIELD_MAX_CHARS): string | undefined {
    if (typeof value !== 'string') return undefined;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * 解析 provider 的 `list` 输出。**永不抛错**：非法 JSON / 缺 items / 条目缺字段
 * 都退化成「空列表 + dropped 计数」，由调用方决定怎么呈现。
 */
export function parseTodoList(stdout: string): TodoListParse | { error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        const head = stdout.trim().slice(0, 200);
        return { error: `provider did not output JSON: ${head || '(empty)'}` };
    }
    const rawItems = (parsed as { items?: unknown })?.items;
    if (!Array.isArray(rawItems)) {
        return { error: "provider output has no `items` array" };
    }

    const items: TodoItem[] = [];
    let dropped = 0;
    for (const raw of rawItems) {
        if (items.length >= TODO_LIST_MAX_ITEMS) break;
        if (!raw || typeof raw !== 'object') { dropped++; continue; }
        const r = raw as Record<string, unknown>;
        const id = str(r.id);
        const title = str(r.title, TODO_TITLE_MAX_CHARS);
        // id/title 是契约里仅有的两个必填项；缺任一就没法定位或展示
        if (!id || !title) { dropped++; continue; }
        const priority = PRIORITIES.includes(r.priority as TodoPriority)
            ? (r.priority as TodoPriority) : undefined;
        items.push({
            id,
            title,
            status: r.status === 'done' ? 'done' : 'open',
            ...(str(r.due) ? { due: str(r.due)! } : {}),
            ...(priority ? { priority } : {}),
            ...(str(r.group) ? { group: str(r.group)! } : {}),
            ...(str(r.note) ? { note: str(r.note)! } : {}),
        });
    }
    return { items, dropped, truncated: rawItems.length > TODO_LIST_MAX_ITEMS };
}

/**
 * 组装 provider 的 argv。**只从本机配置取 command/args**——web 传来的东西只能进
 * 尾部的动作参数，绝不能影响可执行文件本身（spec 风险 1：那是 RCE 边界）。
 */
export function buildProviderArgv(
    config: { command: string; args?: string[] },
    verb: 'list' | 'complete' | 'create',
    operand?: string,
): string[] {
    const argv = [config.command, ...(config.args ?? []), verb];
    if (verb !== 'list') {
        argv.push(operand ?? '');
    }
    return argv;
}
