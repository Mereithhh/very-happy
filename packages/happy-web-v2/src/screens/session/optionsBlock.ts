/**
 * `<options><option>…</option></options>` 的**唯一**解析实现。
 *
 * 这个块由系统提示词要求 agent 输出（`sync/prompt/systemPrompt.ts`），UI 把它渲染成
 * 可点的回答按钮，语音助手则必须把它从朗读文本里摘掉（念 XML 是噪音）。
 *
 * 以前有两份实现，语义不一致（2026-09-04 实测 7 例对照）：
 *   - `Markdown.tsx` 的逐行版：认行首、每行只认第一个 `<option>`、允许不闭合；
 *   - `assistantView.ts` 的全局正则版：不认行首、要求闭合、**不认代码围栏**。
 * 合并方向是让全局正则那侧迁过来，而不是反过来，因为全局正则有两个真 bug：
 *   ① 围栏内的 `<options>` 示例也会被切走——而提示词明写「Do not wrap it into a
 *      codeblock」，正说明模型会这么写；任何一次「解释 options 协议」的对话都会被切烂。
 *   ② 未闭合（流式中途只到达半个块）时它一个 option 都不给，原文留在正文里；而
 *      `LiveStreamView` 每秒重渲 ~12 次，用户会看着那坨 XML 抖到消息落地为止。
 * 所以本模块的语义 = **逐行 + 跟踪围栏 + 容忍未闭合**，并顺手修掉「同一行多个
 * `<option>` 只认第一个」。
 */

export type OptionsSegment =
    | { kind: 'text'; text: string }
    | { kind: 'options'; items: string[] };

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const OPEN_RE = /^\s*<options>/i;
const CLOSE_RE = /^\s*<\/options>/i;
const OPTION_RE = /<option>([\s\S]*?)<\/option>/gi;
const INLINE_CLOSE_RE = /<\/options>/i;
const INLINE_BLOCK_RE = /<options>([\s\S]*?)<\/options>/gi;

/**
 * 把一段 agent 文本切成 markdown 段与 options 段。
 *
 * 未闭合的块按「到文本结尾」处理（流式中途），已经到齐的 `<option>` 照样出按钮。
 * 代码围栏内的 `<options>` 原样留在 text 段里（当代码渲染，不当协议）。
 */
export function splitOptionSegments(raw: string): OptionsSegment[] {
    if (!raw) return [];
    if (raw.indexOf('<options>') === -1 && raw.indexOf('<OPTIONS>') === -1) {
        return [{ kind: 'text', text: raw }];
    }
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const segments: OptionsSegment[] = [];
    let buffer: string[] = [];
    let fence: string | null = null;

    const flushText = () => {
        if (buffer.length === 0) return;
        const text = buffer.join('\n');
        buffer = [];
        if (text.trim().length > 0) segments.push({ kind: 'text', text });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(FENCE_RE);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (fence === null) fence = marker[0];
            else if (marker[0] === fence) fence = null;
            buffer.push(line);
            continue;
        }
        if (fence !== null || !OPEN_RE.test(line)) {
            buffer.push(line);
            continue;
        }
        // options block: consume until </options> or end of text
        flushText();
        const items: string[] = [];
        const collect = (source: string) => {
            for (const match of source.matchAll(OPTION_RE)) {
                const item = match[1].trim();
                if (item) items.push(item);
            }
        };
        const rest = line.replace(OPEN_RE, '');
        const sameLineClose = rest.search(INLINE_CLOSE_RE);
        if (sameLineClose >= 0) {
            // `<options><option>A</option></options>` all on one line. The prompt
            // only *suggests* dedicated lines ("Always dedicate … to a dedicated
            // line"), so models write this shape; walking forward for a closing
            // tag that already went by used to swallow the entire remainder of
            // the message (every paragraph after the block disappeared).
            collect(rest.slice(0, sameLineClose));
            const trailing = rest.slice(sameLineClose).replace(INLINE_CLOSE_RE, '');
            if (items.length > 0) segments.push({ kind: 'options', items });
            if (trailing.trim().length > 0) buffer.push(trailing);
            continue;
        }
        collect(rest);
        i++;
        while (i < lines.length && !CLOSE_RE.test(lines[i])) {
            collect(lines[i]);
            i++;
        }
        // i now points at the closing tag (or past the end); anything trailing on
        // the closing line is protocol noise, not content.
        if (items.length > 0) segments.push({ kind: 'options', items });
    }
    flushText();
    return segments;
}

/**
 * 语音助手用的形状：正文（去掉 options 块）+ 扁平的选项列表。
 * 与 `splitOptionSegments` 同源，避免两份实现再次漂移。
 */
export function extractOptions(raw: string): { text: string; options: string[] } {
    const segments = splitOptionSegments(raw);
    const options = segments.flatMap((segment) => (segment.kind === 'options' ? segment.items : []));
    let text = segments
        .filter((segment): segment is Extract<OptionsSegment, { kind: 'text' }> => segment.kind === 'text')
        .map((segment) => segment.text)
        .join('\n')
        .trim();
    // `splitOptionSegments` deliberately only recognises a block that STARTS a
    // line, because a mid-sentence `<options>` would otherwise tear a paragraph
    // in half on screen. The speech path has no such constraint and must never
    // read XML aloud, so anything left over is swept here (and its options are
    // still offered as buttons).
    if (text.indexOf('<options>') !== -1) {
        let fence: string | null = null;
        text = text
            .split('\n')
            .map((line) => {
                const fenceMatch = line.match(FENCE_RE);
                if (fenceMatch) {
                    const marker = fenceMatch[1][0];
                    if (fence === null) fence = marker;
                    else if (marker === fence) fence = null;
                    return line;
                }
                if (fence !== null) return line;   // a fenced example is content, not protocol
                return line.replace(INLINE_BLOCK_RE, (_all, inner: string) => {
                    for (const match of inner.matchAll(OPTION_RE)) {
                        const item = match[1].trim();
                        if (item) options.push(item);
                    }
                    return '';
                });
            })
            .join('\n')
            .trim();
    }
    return { text, options };
}
