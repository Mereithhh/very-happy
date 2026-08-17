/**
 * ── 终端通道 v2 写入端编码层（B-121 / spec §D1b）────────────────────────────
 *
 * v1 的 daemon 写入端是 `session.pty.write(utf8)` —— 有一条真 pty 可写。
 * v2 的 daemon 只有一个 **tmux control mode 客户端**（`tmux -C attach`，pipe 非
 * pty），写入必须改成往 control 通道 stdin 写 **tmux 命令行文本**。本模块是这
 * 一层的**纯函数**：给字节，出命令；不碰进程、不碰磁盘、不碰时钟。
 *
 * 三通道分类（iTerm2 十年生产验证，spec 已定死，按 run-length 合并）：
 *   - ASCII 可打印（0x20..0x7e） → `send-keys -lt <pane> -- '<literal>'`
 *   - 非 ASCII                    → `send-keys -t <pane> 0xNNNN…`（**按码点**）
 *   - C0 / DEL（0x00..0x1f, 0x7f）→ `send-keys -H -t <pane> <hex…>`
 *
 * 为什么非 ASCII 必须按**码点**而不是按字节（spec R1 M5，本 worktree 3.7b 复验）：
 *   `send-keys -t %0 0xe4 0xb8 0xad` → pane 收到 `ä¸­`（tmux 把每个 0xNN 当一个
 *   **键**，再各自 UTF-8 编码）；`send-keys -t %0 0x4e2d` → pane 收到 `中`。
 *   emoji 同理：`0x1f600` → `😀`（f0 9f 98 80）。
 *
 * 为什么 C0 走 `-H` 而不是 `0xNN`：`0xNN` 走的是 key-name/数值解析路径，tmux
 * 3.5+ 上对 C0 有静默劣化的历史（spec 引 iTerm2）。`-H` 是**裸字节**语义：
 * 本 worktree tmux 3.7b 实测 `-H e4 b8 ad` → pane 精确收到 e4 b8 ad（3 字节），
 * 而 `-H 4e2d` 被拒（>0xff）—— 即 `-H` 的每个参数 = 一个原始字节。这条性质同时
 * 给了我们**非法 UTF-8 字节的兜底通道**：解不出码点的字节原样走 -H，一个不丢。
 *
 * ⚠️ 写入端硬纪律：**绝不产出裸空行**。往 control client 的 stdin 写一个空行
 * = detach（本 worktree 实测：写 `\n` 后 client 立刻 `%exit`，其后的命令全丢）。
 * 因此：空输入返回空数组（不是空字符串命令）；`-l` 通道的载荷按构造只含
 * 0x20..0x7e，永不含换行；`toControlStdin()` 还有一道断言兜底。
 *
 * quoting 语义按 **tmux 命令行**解析，不是 shell argv —— 因为命令是写进 control
 * stdin 的一行文本。实测（3.7b）：单引号内 `\ $ ; # { } "` 全部原样；内部单引号
 * 按 shell 规则拆接 `'it'\''s'` 也成立。所以同一套 `tmuxSingleQuote` 够用。
 * 每条命令同时提供 `argv`（直接 spawn tmux 用，零 quoting）与 `line`（写 control
 * stdin 用，已 quoting）——Phase 1 两种形态都可能要（no-tmux/冷路径 spawnSync
 * vs control 通道）。
 *
 * 纯函数、零 I/O、vitest 全覆盖（sendKeysEncoding.test.ts）。硬门另有 pane 侧
 * 字节捕获 harness：`scripts/probe/term-sendkeys-bytecmp.mjs`。
 */

/**
 * 三通道 + 一条**默认关闭**的第四通道 `keyname`（见 {@link TMUX_KEY_NAME_ALIASES}）。
 * 载荷的**来源字节**决定通道，与目标无关。
 */
export type SendKeysChannel = 'literal' | 'codepoint' | 'hex' | 'keyname';

export type TmuxCommandKind = 'send-keys' | 'load-buffer' | 'paste-buffer';

/** 一条 tmux 命令的双形态。`line` 永不为空、永不含换行（见文件头硬纪律）。 */
export interface TmuxCommand {
    kind: TmuxCommandKind;
    /** send-keys 才有：这条命令用的是哪个通道。 */
    channel?: SendKeysChannel;
    /** 直接 spawn/execFile tmux 的 argv（不含 'tmux' 本身），零 quoting。 */
    argv: string[];
    /** 写进 control client stdin 的**一行**命令文本（不含行尾换行）。 */
    line: string;
}

/** 单条 send-keys 的**载荷字节**上限（spec：≤1000 字节分片）。
 *  量的是**来源字节数**，不是命令行长度：`'` 拆接与 hex 展开都会让行更长，
 *  但 tmux 的命令行长度实测远无 1000 的约束（3.7b 上 20000 字符字面量照收）。 */
export const MAX_SEND_KEYS_PAYLOAD_BYTES = 1000;

// ═══════════════════════════════════════════════════════════════════════════
// quoting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * tmux 命令行的单引号 quoting。单引号内一切原样（tmux 与 shell 同规则），
 * 内部单引号按 shell 规则拆接：`it's` → `'it'\''s'`（3.7b 实测通过）。
 */
export function tmuxSingleQuote(text: string): string {
    return `'${text.split("'").join("'\\''")}'`;
}

/** 结构 token（命令名/开关/pane 目标/hex/0xNN）不需要引号；只有载荷与路径要。 */
const BARE_TOKEN = /^[A-Za-z0-9_%$=:@,.\/+-]+$/;

function joinLine(argv: string[], quoted: ReadonlySet<number>): string {
    return argv
        .map((tok, i) => (quoted.has(i) || !BARE_TOKEN.test(tok) ? tmuxSingleQuote(tok) : tok))
        .join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 分段：字节 → 三通道 run
// ═══════════════════════════════════════════════════════════════════════════

interface Segment {
    channel: SendKeysChannel;
    /** literal/hex：字节值；codepoint：Unicode 码点。 */
    items: number[];
    /** 这一段吃掉的**来源字节数**（分片预算按它算）。 */
    itemBytes: number[];
    /** keyname 段专用：tmux 键名（如 'Home'）。 */
    keyName?: string;
}

/**
 * ── 第四通道：tmux 键名（默认**关闭**，`normalizeKeyNames: true` 才启用）─────
 *
 * 出处：`scripts/probe/term-sendkeys-bytecmp.mjs` 的首轮实跑（tmux 3.7b，142 用例）
 * 打出来的**唯一** 4 条差异，全在 Home/End 上：
 *
 *   用例        web 发的字节   v1(attach) pane 收到   v2(send-keys 原样) pane 收到
 *   Home        1b 5b 48       1b 5b 31 7e (`ESC[1~`)  1b 5b 48 (`ESC[H`)
 *   End         1b 5b 46       1b 5b 34 7e (`ESC[4~`)  1b 5b 46 (`ESC[F`)
 *   Home(DECCKM) 1b 4f 48      1b 5b 31 7e             1b 4f 48
 *   End(DECCKM)  1b 4f 46      1b 5b 34 7e             1b 4f 46
 *
 * 根因：v1 的 attach client **不是透明字节管道**——它把字节解成「键」，再按 pane
 * 的 terminfo/模式**重新编码**。Home/End 恰好是 xterm 编码（`ESC[H`/`ESC[F`）与
 * tmux 编码（`ESC[1~`/`ESC[4~`）不一致的两个键。其余 138/142（含全部 F1-F12、
 * 方向键 ×4 修饰、PageUp/Down、Insert/Delete、Ctrl+a..z、Ctrl 标点、Tab/Enter/Esc）
 * 两条路径逐字节相同。
 *
 * 这条通道把这 4 条序列改发 tmux **键名**（`send-keys -t <pane> Home`），让 tmux
 * 用自己的编码器出字节 ⇒ 与 v1 完全一致（实测 DECCKM 两态都是 `ESC[1~`/`ESC[4~`）。
 *
 * **默认关闭**：spec §D1b 定稿写死的是三通道，「按 pane 侧兼容做键名归一」属于
 * 设计变更，不该由实现阶段单方面拍板。开关留在这里，Phase 1 / Owner 决定后
 * 一行翻开（harness 有 `--normalize` 可当场量化两种取值的结果）。
 */
export const TMUX_KEY_NAME_ALIASES: ReadonlyArray<{ readonly seq: string; readonly keyName: string }> = [
    { seq: '\x1b[H', keyName: 'Home' },
    { seq: '\x1bOH', keyName: 'Home' },
    { seq: '\x1b[F', keyName: 'End' },
    { seq: '\x1bOF', keyName: 'End' },
];

const ALIAS_BYTES = TMUX_KEY_NAME_ALIASES.map((a) => ({
    bytes: [...a.seq].map((c) => c.charCodeAt(0)),
    keyName: a.keyName,
}));

function matchAlias(bytes: Uint8Array, i: number): { keyName: string; len: number } | null {
    for (const a of ALIAS_BYTES) {
        if (i + a.bytes.length > bytes.length) continue;
        let ok = true;
        for (let k = 0; k < a.bytes.length; k++) if (bytes[i + k] !== a.bytes[k]) { ok = false; break; }
        if (ok) return { keyName: a.keyName, len: a.bytes.length };
    }
    return null;
}

/**
 * 严格 UTF-8 单序列解码（拒绝 overlong / 代理区 / >U+10FFFF / 截断）。
 * 解不出 → null，调用方把该字节丢进 -H 原样通道。
 */
function decodeUtf8At(bytes: Uint8Array, i: number): { cp: number; len: number } | null {
    const b0 = bytes[i];
    let len: number;
    let cp: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) { len = 2; cp = b0 & 0x1f; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { len = 3; cp = b0 & 0x0f; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { len = 4; cp = b0 & 0x07; }
    else return null;
    if (i + len > bytes.length) return null;
    for (let k = 1; k < len; k++) {
        const b = bytes[i + k];
        if (b < 0x80 || b > 0xbf) return null;
        cp = (cp << 6) | (b & 0x3f);
    }
    if (len === 3 && cp < 0x800) return null;
    if (len === 4 && cp < 0x10000) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    if (cp > 0x10ffff) return null;
    return { cp, len };
}

function segment(bytes: Uint8Array, normalizeKeyNames: boolean): Segment[] {
    const segs: Segment[] = [];
    const push = (channel: SendKeysChannel, item: number, byteLen: number) => {
        const last = segs[segs.length - 1];
        if (last && last.channel === channel) {
            last.items.push(item);
            last.itemBytes.push(byteLen);
            return;
        }
        segs.push({ channel, items: [item], itemBytes: [byteLen] });
    };
    let i = 0;
    while (i < bytes.length) {
        if (normalizeKeyNames) {
            const alias = matchAlias(bytes, i);
            if (alias) {
                segs.push({ channel: 'keyname', items: [], itemBytes: [], keyName: alias.keyName });
                i += alias.len;
                continue;
            }
        }
        const b = bytes[i];
        if (b >= 0x20 && b <= 0x7e) { push('literal', b, 1); i += 1; continue; }
        if (b <= 0x1f || b === 0x7f) { push('hex', b, 1); i += 1; continue; }
        const dec = decodeUtf8At(bytes, i);
        if (dec) { push('codepoint', dec.cp, dec.len); i += dec.len; continue; }
        // 非法 UTF-8：-H 原样发这一个字节（tmux -H = 裸字节，3.7b 实测）。
        push('hex', b, 1); i += 1;
    }
    return segs;
}

/** 把一段按「来源字节数 ≤ max」切片；单个 item 超预算时独占一片（不撕码点）。 */
function chunkSegment(seg: Segment, max: number): number[][] {
    const chunks: number[][] = [];
    let cur: number[] = [];
    let curBytes = 0;
    for (let k = 0; k < seg.items.length; k++) {
        const cost = seg.itemBytes[k];
        if (cur.length > 0 && curBytes + cost > max) {
            chunks.push(cur);
            cur = [];
            curBytes = 0;
        }
        cur.push(seg.items[k]);
        curBytes += cost;
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// send-keys 命令构造
// ═══════════════════════════════════════════════════════════════════════════

function literalCommand(paneTarget: string, byteValues: number[]): TmuxCommand {
    const payload = String.fromCharCode(...byteValues);
    // 按构造不可能，留作机制断言：`-l` 载荷若含换行，写进 control stdin 就变
    // 成「命令 + 裸空行」= detach。
    if (/[\r\n]/.test(payload)) throw new Error('sendKeysEncoding: literal payload contains a newline');
    const argv = ['send-keys', '-lt', paneTarget, '--', payload];
    return { kind: 'send-keys', channel: 'literal', argv, line: joinLine(argv, new Set([4])) };
}

function codepointCommand(paneTarget: string, codepoints: number[]): TmuxCommand {
    const args = codepoints.map((cp) => `0x${cp.toString(16)}`);
    const argv = ['send-keys', '-t', paneTarget, ...args];
    return { kind: 'send-keys', channel: 'codepoint', argv, line: joinLine(argv, new Set()) };
}

function hexCommand(paneTarget: string, byteValues: number[]): TmuxCommand {
    const args = byteValues.map((b) => b.toString(16).padStart(2, '0'));
    const argv = ['send-keys', '-Ht', paneTarget, ...args];
    return { kind: 'send-keys', channel: 'hex', argv, line: joinLine(argv, new Set()) };
}

function keyNameCommand(paneTarget: string, keyName: string): TmuxCommand {
    const argv = ['send-keys', '-t', paneTarget, keyName];
    return { kind: 'send-keys', channel: 'keyname', argv, line: joinLine(argv, new Set()) };
}

/** string | bytes → UTF-8 字节。孤代理由 Buffer/TextEncoder 换成 U+FFFD。 */
function toBytes(input: string | Uint8Array): Uint8Array {
    return typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'utf8')) : input;
}

export interface EncodeSendKeysOptions {
    /** 单条命令载荷字节上限，默认 {@link MAX_SEND_KEYS_PAYLOAD_BYTES}。 */
    maxPayloadBytes?: number;
    /**
     * 把 {@link TMUX_KEY_NAME_ALIASES}（Home/End）改发 tmux 键名，让 pane 收到的
     * 字节与 v1(attach) 一致。**默认 false = spec 定稿的三通道行为**；开之前先读
     * TMUX_KEY_NAME_ALIASES 的注释与 harness 的实测数据。
     */
    normalizeKeyNames?: boolean;
}

/**
 * 把一段用户输入编码成一串 tmux 命令（FIFO 保序，按数组顺序写进 control stdin）。
 * 空输入 → `[]`（**绝不**返回空命令：空行 = detach）。
 */
export function encodeSendKeys(
    input: string | Uint8Array,
    paneTarget: string,
    opts: EncodeSendKeysOptions = {},
): TmuxCommand[] {
    const max = Math.max(1, opts.maxPayloadBytes ?? MAX_SEND_KEYS_PAYLOAD_BYTES);
    const out: TmuxCommand[] = [];
    for (const seg of segment(toBytes(input), opts.normalizeKeyNames === true)) {
        if (seg.channel === 'keyname') { out.push(keyNameCommand(paneTarget, seg.keyName!)); continue; }
        for (const chunk of chunkSegment(seg, max)) {
            if (seg.channel === 'literal') out.push(literalCommand(paneTarget, chunk));
            else if (seg.channel === 'codepoint') out.push(codepointCommand(paneTarget, chunk));
            else out.push(hexCommand(paneTarget, chunk));
        }
    }
    return out;
}

/**
 * 一串命令 → 可直接 `stdin.write()` 的文本（每条一行，含行尾换行）。
 * 空数组 → `''`（**不是** `'\n'`）。任何空行/内嵌换行都在这里抛，不放出去。
 */
export function toControlStdin(commands: readonly TmuxCommand[]): string {
    let outText = '';
    for (const c of commands) {
        if (c.line.length === 0) throw new Error('sendKeysEncoding: refusing to emit a blank control line (= detach)');
        if (/[\r\n]/.test(c.line)) throw new Error(`sendKeysEncoding: control line contains a newline: ${JSON.stringify(c.line)}`);
        outText += `${c.line}\n`;
    }
    return outText;
}

// ═══════════════════════════════════════════════════════════════════════════
// 查询应答过滤（spec §D1b「查询应答过滤」，R1 M1 实证）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * pane 里的应用发查询（DA/DA2、DSR/CPR、OSC 10/11 颜色…）时，**tmux 自己已经
 * 代答了**，同时那串查询原样透传进 %output → web 的 xterm.js 看见后**也会自动
 * 吐一份应答**回来。v1 下这份回灌被 attach client 的 tmux 输入解析器吃掉（实测
 * pane 收 0 字节）；v2 下 send-keys 会把它**原样注入 pane stdin**（实测 7 字节
 * 全到）= 脏输入。所以 daemon 侧必须剥。
 *
 * 粒度 = **整块**，不是「块内正则剜除」，这是刻意的：
 *  - web 侧 `sendInput` 是**逐次 onData 一条 socket 消息**（WebTerminalScreen.tsx
 *    的 `term.onData(sendInput)`，无批量合并），而 xterm.js 的自动应答走的是独立
 *    的一次 onData —— 应答永远自成一块，不会和按键字节混在同一块里；
 *  - 反过来，在任意用户输入里做正则剜除，等于对「用户手打/粘贴的、长得像应答
 *    的文本」下手（`\x1b[` 前缀内容、日志片段、转义序列教程…），必然误伤。
 * 所以规则是：**整块只由已知应答构成 → 整块丢弃；只要混进一个别的字节 → 原样
 * 放行**。这也正是 `scripts/probe/term-input-goldendiff.mjs` 采样端已经在用、
 * 并被实跑验证过的同一条规则（README §血泪「终端自动回复会混进采样」）。
 *
 * 白名单（每条都有出处）：
 *  - `CSI ? … c`  DA1 应答（xterm.js `\x1b[?1;2c`）
 *  - `CSI > … c`  DA2/DA3 应答（xterm.js `\x1b[>0;276;0c`）
 *  - `CSI 0 n` / `CSI 3 n`  DSR 状态应答（**只收 0/3 两个应答值**；`CSI 6 n`
 *    是查询不是应答，不剥）
 *  - `CSI r ; c R`  CPR、`CSI ? r ; c ; p R`  DECXCPR
 *  - `CSI ? Ps ; Pm $ y`  DECRPM（DECRQM 的应答）
 *  - `OSC 10/11/12 ; rgb:… ST|BEL`、`OSC 4 ; n ; rgb:… ST|BEL` 颜色应答
 *  - `DCS > | … ST`  XTVERSION 应答
 *
 * **刻意不剥**：DEC 1004 焦点上报 `CSI I` / `CSI O`。它不是「tmux 已代答、web
 * 又答一遍」的重复应答，而是应用自己请求订阅的真实焦点事件——剥了等于把用户
 * 的真实信号吞掉。（goldendiff 的采样过滤器包含它，是因为那里要的是「按键产物」，
 * 语境不同。）
 */
const AUTO_REPLY_PATTERNS: readonly RegExp[] = [
    /\x1b\[\?[0-9;]*c/y,                             // DA1
    /\x1b\[>[0-9;]*c/y,                              // DA2 / DA3
    /\x1b\[[03]n/y,                                  // DSR 应答
    /\x1b\[[0-9]+;[0-9]+R/y,                         // CPR
    /\x1b\[\?[0-9]+;[0-9]+(?:;[0-9]+)?R/y,           // DECXCPR
    /\x1b\[\?[0-9]+;[0-9]+\$y/y,                     // DECRPM
    /\x1b\](?:1[0-9]|4);(?:[0-9]+;)?rgb:[0-9a-fA-F/]+(?:\x1b\\|\x07)/y, // OSC 4/10..19 颜色应答
    /\x1bP>\|[^\x1b]*\x1b\\/y,                       // XTVERSION 应答
];

/**
 * 这一块**是否整块**由已知自动应答构成（空串不算）。
 */
export function isAutoReplyOnly(data: string): boolean {
    if (data.length === 0) return false;
    let i = 0;
    outer: while (i < data.length) {
        for (const re of AUTO_REPLY_PATTERNS) {
            re.lastIndex = i;
            const m = re.exec(data);
            if (m && m.index === i) { i = re.lastIndex; continue outer; }
        }
        return false;
    }
    return true;
}

/** 整块是自动应答 → `''`（调用方据此整块丢弃）；否则原样返回。 */
export function filterAutoReplies(data: string): string {
    return isAutoReplyOnly(data) ? '' : data;
}

/**
 * Phase 1 的写入端入口：过滤 → 编码。`dropped=true` 表示整块被判为自动应答
 * （调用方可据此打点，不必再看 commands）。
 */
export function encodeTerminalWrite(
    input: string,
    paneTarget: string,
    opts: EncodeSendKeysOptions = {},
): { commands: TmuxCommand[]; dropped: boolean } {
    if (isAutoReplyOnly(input)) return { commands: [], dropped: true };
    return { commands: encodeSendKeys(input, paneTarget, opts), dropped: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// 粘贴专路（spec §D1b「粘贴专路」）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 粘贴**不能**走 send-keys：pane 开了 bracketed paste(2004) 时，逐键注入不会带
 * `ESC[200~ … ESC[201~` 包裹，多行粘贴会被 shell 逐行执行。tmux 的
 * `paste-buffer -p` 会**按 pane 的真实 2004 状态**决定要不要包裹（本 worktree
 * 3.7b 实测：2004 关 → `line1\rline2\rline3\r`；2004 开 → `ESC[200~line1\r…
 * ESC[201~`）——这正是我们要的。
 *
 * 装载路径只能是**临时文件**：control mode 下 `load-buffer -` 从 stdin 读不通，
 * 因为 stdin 就是命令通道本身（3.7b 实测 `Bad file descriptor: -` + `%error`，
 * spec 盲审结论复现）。临时文件路径实测可行，且这两条命令与 send-keys **同一
 * 条 stdin FIFO**，天然保序（这正是「粘贴 + 立刻回车」不乱序的根据；v1 的
 * spawnSync 双执行器做不到）。
 */
export interface PastePlan {
    /** tmux buffer 名（`-b`）。每次粘贴一个新名字，避免与并发粘贴/用户 buffer 撞。 */
    bufferName: string;
    /** 临时文件绝对路径。**调用方负责**：先落盘，再发命令，命令写完即删。 */
    path: string;
    /** 要写进临时文件的字节（UTF-8）。 */
    bytes: Uint8Array;
    /** load-buffer + paste-buffer 两条命令，按序发。 */
    commands: TmuxCommand[];
}

let pasteBufferSeq = 0;

/**
 * 生成一个粘贴专用 buffer 名。`vh-paste-<seq>-<rand>`：seq 保证同进程内不撞、
 * rand 保证跨进程（同一台机可能有多个 daemon/测试）不撞。
 */
export function nextPasteBufferName(): string {
    pasteBufferSeq = (pasteBufferSeq + 1) % 0xffffff;
    const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    return `vh-paste-${pasteBufferSeq.toString(16)}-${rand}`;
}

/** 纯构造：只出命令对，不生成名字、不碰盘。 */
export function encodePasteCommands(paneTarget: string, filePath: string, bufferName: string): TmuxCommand[] {
    if (filePath.length === 0) throw new Error('sendKeysEncoding: empty paste file path');
    if (bufferName.length === 0) throw new Error('sendKeysEncoding: empty paste buffer name');
    if (/[\r\n]/.test(filePath) || /[\r\n]/.test(bufferName)) {
        throw new Error('sendKeysEncoding: paste path/buffer name contains a newline');
    }
    const loadArgv = ['load-buffer', '-b', bufferName, filePath];
    const pasteArgv = ['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneTarget];
    return [
        { kind: 'load-buffer', argv: loadArgv, line: joinLine(loadArgv, new Set([3])) },
        // `-d` 让 tmux 粘完即删 buffer；文件的删除是调用方的事（见 PastePlan）。
        { kind: 'paste-buffer', argv: pasteArgv, line: joinLine(pasteArgv, new Set()) },
    ];
}

export interface BuildPastePlanOptions {
    /** 临时文件所在目录（Phase 1 传 `os.tmpdir()` 或 HAPPY_HOME_DIR 下的子目录）。 */
    dir: string;
    /** 注入 buffer 名（测试用）；不给就 {@link nextPasteBufferName}。 */
    bufferName?: string;
}

/**
 * 纯函数版「粘贴计划」：产出**要写什么文件**与**要发哪两条命令**，一个字节也不落盘
 * ——vitest 里可以整条测完。Phase 1 的实际动作只剩三行：`writeFile(plan.path,
 * plan.bytes, {mode:0o600})` → `stdin.write(toControlStdin(plan.commands))` →
 * `unlink(plan.path)`。
 */
export function buildPastePlan(text: string, paneTarget: string, opts: BuildPastePlanOptions): PastePlan {
    const bufferName = opts.bufferName ?? nextPasteBufferName();
    // 路径用 buffer 名当文件名：同一把随机数，天然不撞；空格/引号照样被 quoting
    // 兜住（实测带空格的路径可行）。
    const sep = opts.dir.endsWith('/') ? '' : '/';
    const path = `${opts.dir}${sep}${bufferName}.txt`;
    return {
        bufferName,
        path,
        bytes: new Uint8Array(Buffer.from(text, 'utf8')),
        commands: encodePasteCommands(paneTarget, path, bufferName),
    };
}
