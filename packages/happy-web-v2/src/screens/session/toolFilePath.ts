/**
 * 从工具调用里抽取文件路径，并据此建立「本会话可点路径」白名单（B-145）。
 *
 * 为什么是白名单而不是正则：自由文本里认路径必然假阳性——`package.json` 出现在
 * 散文里、版本号 `1.2/3`、分数 `a/b`、`node_modules` 都会被认成路径。而**误判的
 * 代价比漏判高**：一个点了没反应的链接比没有链接更烦人。
 *
 * 工具调用的 `file_path` 是**结构化且确定存在**的路径集合，以它为白名单：
 *   - claude 用 Write 写了 docs/report.md → 进白名单
 *   - 它在正文里说「见 docs/report.md」 → 命中 → 变可点
 *   - 它提了 package.json 但这轮没碰过 → 不可点（点了也只会报错）
 * 假阳性为零，且恰好覆盖真实场景（「它刚写的那个文件我想看」）。
 *
 * ⚠️ 刻意**不套用** B-131 的敏感路径 denylist：那条 denylist 的设计理由是挡「**模型**
 * 主动推给你看」，明确不改变「**你自己**导航」的既有事实（见 2026-08-open-preview
 * spec D4）。点击是自主行为，等同于在文件浏览器里手动翻进去。
 */
import type { Message, ToolCall } from '@/sync/typesMessage';

/** 会带文件路径的工具（Claude Code 内建那批）。 */
const FILE_PATH_TOOLS = new Set([
    'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

function asString(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 一个工具调用指向的文件路径；没有就返回 null。
 * `locations[0].path` 是某些变体的形状（ToolView 已在读它）。
 */
export function toolFilePathOf(tool: ToolCall): string | null {
    if (!FILE_PATH_TOOLS.has(tool.name)) return null;
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const direct = asString(input.file_path);
    if (direct) return direct;
    const locations = input.locations;
    if (Array.isArray(locations) && locations.length > 0) {
        const first = locations[0] as { path?: unknown } | null;
        return asString(first?.path);
    }
    return null;
}

/**
 * 本会话出现过的文件路径白名单（原样，未解析成绝对路径——解析要靠 cwd，
 * 而匹配正文时用的是 claude 写出来的原样字符串）。
 */
export function collectSessionFilePaths(messages: readonly Message[]): Set<string> {
    const paths = new Set<string>();
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        const path = toolFilePathOf(message.tool);
        if (path) paths.add(path);
    }
    return paths;
}

/**
 * 相对路径按会话 cwd 解析成绝对路径。`~` 不展开——那是机器侧的事，
 * daemon 的 fs-read 自己认（`normalizeFsPath`）。
 */
export function resolveAgainstCwd(path: string, cwd: string | null | undefined): string {
    const p = path.trim();
    if (!p) return p;
    if (p.startsWith('/') || p.startsWith('~')) return p;
    if (!cwd) return p;   // 没有 cwd 就原样交给 daemon，它会报 not-found 而不是猜
    return `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`;
}

/**
 * 在一段文本里找出白名单路径的出现位置，按出现顺序、互不重叠。
 * 给 Markdown 渲染用：它据此把命中的片段换成可点节点。
 *
 * 长路径优先匹配（`a/b/c.md` 与 `c.md` 同时在白名单时，命中前者），
 * 否则会把长路径切碎成两段。
 */
export interface PathHit { start: number; end: number; path: string }

export function findPathHits(text: string, allowlist: ReadonlySet<string>): PathHit[] {
    if (!text || allowlist.size === 0) return [];
    const candidates = [...allowlist].sort((a, b) => b.length - a.length);
    const hits: PathHit[] = [];
    const taken: boolean[] = new Array(text.length).fill(false);
    for (const path of candidates) {
        let from = 0;
        for (;;) {
            const idx = text.indexOf(path, from);
            if (idx === -1) break;
            const end = idx + path.length;
            let overlaps = false;
            for (let i = idx; i < end; i++) if (taken[i]) { overlaps = true; break; }
            // 要求两侧是「非路径字符」边界，避免 foo/bar.md 命中到 xfoo/bar.mdy
            const before = idx === 0 ? '' : text[idx - 1];
            const after = end >= text.length ? '' : text[end];
            const boundaryOk = !/[\w./-]/.test(before) && !/[\w./-]/.test(after);
            if (!overlaps && boundaryOk) {
                for (let i = idx; i < end; i++) taken[i] = true;
                hits.push({ start: idx, end, path });
            }
            from = idx + 1;
        }
    }
    return hits.sort((a, b) => a.start - b.start);
}
