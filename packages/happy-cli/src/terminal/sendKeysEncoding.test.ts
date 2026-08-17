/**
 * sendKeysEncoding 的纯函数全覆盖（B-121 D1b）。
 *
 * 这里的期望值不是凭空写的：每一条通道语义都在本 worktree 的 tmux 3.7b 上、
 * 隔离 socket（`tmux -L b121-p0b`）里用「pane 压成字节水槽 → 落盘 → 逐字节看」
 * 的方式实证过（模块头部注释记了结论）。跨到真 pane 的端到端硬门在
 * `scripts/probe/term-sendkeys-bytecmp.mjs`（142 用例，旧 pty.write vs 新
 * send-keys 对跑）。
 */
import { describe, expect, it } from 'vitest';
import {
    MAX_SEND_KEYS_PAYLOAD_BYTES,
    TMUX_KEY_NAME_ALIASES,
    buildPastePlan,
    encodePasteCommands,
    encodeSendKeys,
    encodeTerminalWrite,
    filterAutoReplies,
    isAutoReplyOnly,
    nextPasteBufferName,
    toControlStdin,
    tmuxSingleQuote,
} from './sendKeysEncoding';

const PANE = '%0';
const lines = (input: string | Uint8Array, opts?: { maxPayloadBytes?: number }) =>
    encodeSendKeys(input, PANE, opts).map((c) => c.line);
const channels = (input: string) => encodeSendKeys(input, PANE).map((c) => c.channel);

describe('tmuxSingleQuote', () => {
    it('包住普通文本', () => {
        expect(tmuxSingleQuote('hello world')).toBe("'hello world'");
    });

    it('内部单引号按 shell 规则拆接（3.7b 实测 pane 收到 it\'s）', () => {
        expect(tmuxSingleQuote("it's")).toBe("'it'\\''s'");
    });

    it('单引号地狱：连续/首尾单引号都不破形', () => {
        expect(tmuxSingleQuote("'")).toBe("''\\'''");
        expect(tmuxSingleQuote("''")).toBe("''\\'''\\'''");
        expect(tmuxSingleQuote("a''b")).toBe("'a'\\'''\\''b'");
    });

    it('反斜杠/$/;/#{}/双引号在单引号里原样（tmux 命令行语义，实测）', () => {
        expect(tmuxSingleQuote('a\\b$c;d#{e}f"g')).toBe("'a\\b$c;d#{e}f\"g'");
    });

    it('空串产出 \'\' 而不是空 token', () => {
        expect(tmuxSingleQuote('')).toBe("''");
    });
});

describe('encodeSendKeys —— 三通道分类', () => {
    it('纯 ASCII 可打印 → 一条 -lt 字面量', () => {
        expect(lines('hello world')).toEqual(["send-keys -lt %0 -- 'hello world'"]);
        expect(channels('hello world')).toEqual(['literal']);
    });

    it('字面量里的单引号走拆接，不另开命令', () => {
        expect(lines("it's")).toEqual(["send-keys -lt %0 -- 'it'\\''s'"]);
    });

    it('C0 → -Ht 十六进制（回车/Esc/Ctrl-C/NUL/Tab）', () => {
        expect(lines('\r')).toEqual(['send-keys -Ht %0 0d']);
        expect(lines('\x1b')).toEqual(['send-keys -Ht %0 1b']);
        expect(lines('\x03')).toEqual(['send-keys -Ht %0 03']);
        expect(lines('\x00')).toEqual(['send-keys -Ht %0 00']);
        expect(lines('\t')).toEqual(['send-keys -Ht %0 09']);
    });

    it('DEL(0x7f，Backspace 的字节) 归 hex 通道，不进字面量', () => {
        expect(lines('\x7f')).toEqual(['send-keys -Ht %0 7f']);
        expect(channels('\x7f')).toEqual(['hex']);
    });

    it('非 ASCII → 按 **Unicode 码点** 的 0xNNNN，不是按字节（spec R1 M5）', () => {
        // 按字节发 0xe4 0xb8 0xad 会得到乱码 ä¸­；按码点 0x4e2d 才是 中。
        expect(lines('中')).toEqual(['send-keys -t %0 0x4e2d']);
        expect(lines('中文')).toEqual(['send-keys -t %0 0x4e2d 0x6587']);
    });

    it('emoji 用完整码点（代理对合成一个 0x1f600），不是两个 UTF-16 码元', () => {
        expect(lines('😀')).toEqual(['send-keys -t %0 0x1f600']);
    });

    it('拉丁扩展/重音字符也走码点通道', () => {
        expect(lines('é')).toEqual(['send-keys -t %0 0xe9']);
    });

    it('三通道混合按出现顺序切段（FIFO 保序）', () => {
        expect(lines("ab中\rcd")).toEqual([
            "send-keys -lt %0 -- 'ab'",
            'send-keys -t %0 0x4e2d',
            'send-keys -Ht %0 0d',
            "send-keys -lt %0 -- 'cd'",
        ]);
    });

    it('IME 提交串（中文 + 标点 + emoji + 回车）整串编码', () => {
        const cmds = encodeSendKeys('你好，world 😀\r', PANE);
        expect(cmds.map((c) => c.channel)).toEqual(['codepoint', 'literal', 'codepoint', 'hex']);
        expect(cmds[0].line).toBe('send-keys -t %0 0x4f60 0x597d 0xff0c');
        expect(cmds[1].line).toBe("send-keys -lt %0 -- 'world '");
        expect(cmds[2].line).toBe('send-keys -t %0 0x1f600');
        expect(cmds[3].line).toBe('send-keys -Ht %0 0d');
    });
});

describe('encodeSendKeys —— run-length 合并', () => {
    it('同通道连续字节合并成一条命令', () => {
        expect(encodeSendKeys('abcdef', PANE)).toHaveLength(1);
        expect(lines('\x1b[A')).toEqual(['send-keys -Ht %0 1b', "send-keys -lt %0 -- '[A'"]);
    });

    it('连续 C0 合并成一条 -Ht，多参数', () => {
        expect(lines('\x1b\x1b\r\n')).toEqual(['send-keys -Ht %0 1b 1b 0d 0a']);
    });

    it('连续非 ASCII 合并成一条码点命令', () => {
        expect(lines('中文测试')).toEqual(['send-keys -t %0 0x4e2d 0x6587 0x6d4b 0x8bd5']);
    });

    it('通道交替时不合并（a中b中）', () => {
        expect(channels('a中b中')).toEqual(['literal', 'codepoint', 'literal', 'codepoint']);
    });
});

describe('encodeSendKeys —— 1000 字节分片边界', () => {
    it('恰好 1000 字节的字面量仍是一条', () => {
        const cmds = encodeSendKeys('x'.repeat(MAX_SEND_KEYS_PAYLOAD_BYTES), PANE);
        expect(cmds).toHaveLength(1);
    });

    it('1001 字节切成 1000 + 1，顺序不乱、内容不丢', () => {
        const text = 'x'.repeat(MAX_SEND_KEYS_PAYLOAD_BYTES) + 'y';
        const cmds = encodeSendKeys(text, PANE);
        expect(cmds).toHaveLength(2);
        expect(cmds[0].argv[4]).toHaveLength(1000);
        expect(cmds[1].argv[4]).toBe('y');
        expect(cmds.map((c) => c.argv[4]).join('')).toBe(text);
    });

    it('分片预算量的是**来源字节数**：3 字节 CJK 每 333 个换一条（999 字节）', () => {
        const cmds = encodeSendKeys('中'.repeat(334), PANE);
        expect(cmds).toHaveLength(2);
        expect(cmds[0].argv).toHaveLength(3 + 333);
        expect(cmds[1].argv).toHaveLength(3 + 1);
    });

    it('分片绝不撕开一个码点（4 字节 emoji 落在边界上时整体后移）', () => {
        const cmds = encodeSendKeys('😀'.repeat(300), PANE, { maxPayloadBytes: 10 });
        // 10 字节预算 = 每条 2 个 emoji（8 字节），第 3 个会超（12>10）。
        expect(cmds.every((c) => c.argv.length - 3 === 2)).toBe(true);
        expect(cmds).toHaveLength(150);
        const cps = cmds.flatMap((c) => c.argv.slice(3));
        expect(cps).toHaveLength(300);
        expect(new Set(cps)).toEqual(new Set(['0x1f600']));
    });

    it('单个 item 超预算时独占一片（预算不是硬截断，一个字节都不丢）', () => {
        const cmds = encodeSendKeys('😀', PANE, { maxPayloadBytes: 1 });
        expect(cmds).toHaveLength(1);
        expect(cmds[0].line).toBe('send-keys -t %0 0x1f600');
    });

    it('hex 通道同样分片', () => {
        const cmds = encodeSendKeys('\x01'.repeat(2500), PANE);
        expect(cmds).toHaveLength(3);
        expect(cmds[0].argv.slice(3)).toHaveLength(1000);
        expect(cmds[2].argv.slice(3)).toHaveLength(500);
    });
});

describe('encodeSendKeys —— 空输入与空行纪律', () => {
    it('空串 → 空数组（绝不产出空命令：空行 = detach）', () => {
        expect(encodeSendKeys('', PANE)).toEqual([]);
        expect(encodeSendKeys(new Uint8Array(0), PANE)).toEqual([]);
    });

    it('toControlStdin 空数组 → 空串（不是 "\\n"）', () => {
        expect(toControlStdin([])).toBe('');
    });

    it('toControlStdin 每条一行、行尾单个 \\n、无空行', () => {
        const text = toControlStdin(encodeSendKeys('ab\r', PANE));
        expect(text).toBe("send-keys -lt %0 -- 'ab'\nsend-keys -Ht %0 0d\n");
        expect(text.split('\n').slice(0, -1).every((l) => l.length > 0)).toBe(true);
    });

    it('任何真实输入编出来的命令行都不含换行（换行永远走 hex 通道）', () => {
        for (const s of ['a\nb', 'a\r\nb', '\n\n\n', '中\n文', "it's\nline2"]) {
            for (const c of encodeSendKeys(s, PANE)) {
                expect(c.line).not.toMatch(/[\r\n]/);
                expect(c.line.length).toBeGreaterThan(0);
            }
        }
    });

    it('toControlStdin 对被构造出来的空行/含换行命令抛错（机制兜底）', () => {
        expect(() => toControlStdin([{ kind: 'send-keys', argv: [], line: '' }])).toThrow(/blank control line/);
        expect(() => toControlStdin([{ kind: 'send-keys', argv: [], line: 'a\nb' }])).toThrow(/newline/);
    });
});

describe('encodeSendKeys —— argv 与 line 两形态一致', () => {
    it('argv 不带 quoting（直接 spawn tmux 用），line 带（写 control stdin 用）', () => {
        const [cmd] = encodeSendKeys("it's", PANE);
        expect(cmd.argv).toEqual(['send-keys', '-lt', '%0', '--', "it's"]);
        expect(cmd.line).toBe("send-keys -lt %0 -- 'it'\\''s'");
    });

    it('pane 目标是 =session: 形式时不被引号破坏', () => {
        const [cmd] = encodeSendKeys('a', '=vh-abc123:');
        expect(cmd.argv[2]).toBe('=vh-abc123:');
        expect(cmd.line).toBe("send-keys -lt =vh-abc123: -- 'a'");
    });

    it('pane 目标里有空格等异常字符时 line 会被引起来（argv 不变）', () => {
        const [cmd] = encodeSendKeys('a', 'weird target');
        expect(cmd.argv[2]).toBe('weird target');
        expect(cmd.line).toBe("send-keys -lt 'weird target' -- 'a'");
    });
});

describe('encodeSendKeys —— 字节输入与非法 UTF-8', () => {
    it('Uint8Array 输入与等价字符串输入产出相同', () => {
        expect(lines(new Uint8Array(Buffer.from('中a\r', 'utf8')))).toEqual(lines('中a\r'));
    });

    it('非法 UTF-8 字节走 -H 原样发（一个字节不丢，不静默换 U+FFFD）', () => {
        expect(lines(new Uint8Array([0x61, 0xff, 0x62]))).toEqual([
            "send-keys -lt %0 -- 'a'",
            'send-keys -Ht %0 ff',
            "send-keys -lt %0 -- 'b'",
        ]);
    });

    it('截断的 UTF-8 序列（只有前导字节）走 -H，不吞后续字符', () => {
        expect(lines(new Uint8Array([0xe4, 0xb8]))).toEqual(['send-keys -Ht %0 e4 b8']);
    });

    it('overlong 编码与代理区编码被拒（各字节走 -H）', () => {
        expect(lines(new Uint8Array([0xc0, 0xaf]))).toEqual(['send-keys -Ht %0 c0 af']);
        expect(lines(new Uint8Array([0xed, 0xa0, 0x80]))).toEqual(['send-keys -Ht %0 ed a0 80']);
    });

    it('JS 孤代理由 Buffer 换成 U+FFFD（不会产出 0xd800 这种非法码点）', () => {
        expect(lines('\ud800')).toEqual(['send-keys -t %0 0xfffd']);
    });
});

describe('查询应答过滤 —— 白名单命中', () => {
    const replies = [
        ['DA1 (xterm.js)', '\x1b[?1;2c'],
        ['DA1 (VT220)', '\x1b[?62;1;2;6;8;9;15c'],
        ['DA2', '\x1b[>0;276;0c'],
        ['DA3-ish', '\x1b[>c'],
        ['DSR ok', '\x1b[0n'],
        ['DSR printer', '\x1b[3n'],
        ['CPR', '\x1b[24;80R'],
        ['DECXCPR', '\x1b[?24;80;1R'],
        ['DECRPM', '\x1b[?2004;2$y'],
        ['OSC 10 fg (ST)', '\x1b]10;rgb:0000/0000/0000\x1b\\'],
        ['OSC 11 bg (BEL)', '\x1b]11;rgb:ffff/ffff/ffff\x07'],
        ['OSC 12 cursor', '\x1b]12;rgb:1234/5678/9abc\x1b\\'],
        ['OSC 4 indexed', '\x1b]4;1;rgb:aaaa/bbbb/cccc\x07'],
        ['XTVERSION', '\x1bP>|xterm.js(5.5.0)\x1b\\'],
    ] as const;

    for (const [name, s] of replies) {
        it(`整块丢弃：${name}`, () => {
            expect(isAutoReplyOnly(s)).toBe(true);
            expect(filterAutoReplies(s)).toBe('');
        });
    }

    it('多条应答连在一块里也整块丢（xterm.js 一次 onData 吐两条的实测形态）', () => {
        const s = '\x1b]10;rgb:0000/0000/0000\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\';
        expect(isAutoReplyOnly(s)).toBe(true);
    });

    it('encodeTerminalWrite 对整块应答不产出任何命令并标 dropped', () => {
        const r = encodeTerminalWrite('\x1b[?1;2c', PANE);
        expect(r).toEqual({ commands: [], dropped: true });
    });
});

describe('查询应答过滤 —— 绝不误伤用户真实输入', () => {
    const passthrough = [
        ['空串（不算应答）', ''],
        ['单独 Esc（用户按 Escape）', '\x1b'],
        ['用户手打 CSI 前缀', '\x1b['],
        ['方向键上（DECCKM off）', '\x1b[A'],
        ['方向键上（DECCKM on）', '\x1bOA'],
        ['F5', '\x1b[15~'],
        ['DSR 查询本身（6n 是问，不是答）', '\x1b[6n'],
        ['DA 查询本身', '\x1b[c'],
        ['焦点上报 in（刻意不剥）', '\x1b[I'],
        ['焦点上报 out（刻意不剥）', '\x1b[O'],
        ['SGR 鼠标滚轮（copy-mode 依赖）', '\x1b[<64;40;12M'],
        ['bracketed paste 包裹', '\x1b[200~hello\x1b[201~'],
        ['应答形状 + 真实按键混在一块 → 原样放行', '\x1b[?1;2ca'],
        ['真实按键 + 应答形状混在一块 → 原样放行', 'a\x1b[0n'],
        ['用户粘贴一段讲转义序列的文本', 'CPR looks like \x1b[24;80R btw'],
        ['纯文本里出现 rgb:', 'color rgb:1234/5678/9abc'],
        ['不完整的 OSC 应答（没有结束符）', '\x1b]11;rgb:ffff/ffff/ffff'],
        ['DECRPM 形状但少了 $y', '\x1b[?2004;2y'],
    ] as const;

    for (const [name, s] of passthrough) {
        it(`原样放行：${name}`, () => {
            expect(isAutoReplyOnly(s)).toBe(false);
            expect(filterAutoReplies(s)).toBe(s);
        });
    }

    it('放行的块照常编码（应答形状 + 真实字节混合）', () => {
        const r = encodeTerminalWrite('a\x1b[0n', PANE);
        expect(r.dropped).toBe(false);
        expect(r.commands.map((c) => c.line)).toEqual([
            "send-keys -lt %0 -- 'a'",
            'send-keys -Ht %0 1b',
            "send-keys -lt %0 -- '[0n'",
        ]);
    });
});

describe('第四通道 keyname（默认关闭）', () => {
    it('默认不启用：Home/End 原样走 hex+literal（= spec 定稿的三通道行为）', () => {
        expect(lines('\x1b[H')).toEqual(['send-keys -Ht %0 1b', "send-keys -lt %0 -- '[H'"]);
        expect(channels('\x1b[H')).toEqual(['hex', 'literal']);
    });

    it('启用后 Home/End 的四种形态都改发 tmux 键名', () => {
        const opts = { normalizeKeyNames: true } as const;
        expect(encodeSendKeys('\x1b[H', PANE, opts).map((c) => c.line)).toEqual(['send-keys -t %0 Home']);
        expect(encodeSendKeys('\x1bOH', PANE, opts).map((c) => c.line)).toEqual(['send-keys -t %0 Home']);
        expect(encodeSendKeys('\x1b[F', PANE, opts).map((c) => c.line)).toEqual(['send-keys -t %0 End']);
        expect(encodeSendKeys('\x1bOF', PANE, opts).map((c) => c.line)).toEqual(['send-keys -t %0 End']);
    });

    it('启用后不误伤形状相近的其它序列（ESC[A / ESC[1~ / ESCOA / ESC[Z）', () => {
        const opts = { normalizeKeyNames: true } as const;
        for (const s of ['\x1b[A', '\x1b[1~', '\x1bOA', '\x1b[Z', '\x1b[4~']) {
            expect(encodeSendKeys(s, PANE, opts)).toEqual(encodeSendKeys(s, PANE));
        }
    });

    it('启用后混合流里的 Home 被单独切出来，前后段不受影响', () => {
        const cmds = encodeSendKeys('ab\x1b[Hcd', PANE, { normalizeKeyNames: true });
        expect(cmds.map((c) => c.line)).toEqual([
            "send-keys -lt %0 -- 'ab'",
            'send-keys -t %0 Home',
            "send-keys -lt %0 -- 'cd'",
        ]);
    });

    it('别名表就是 harness 打出来的那 4 条差异', () => {
        expect(TMUX_KEY_NAME_ALIASES.map((a) => `${JSON.stringify(a.seq)}→${a.keyName}`)).toEqual([
            '"\\u001b[H"→Home', '"\\u001bOH"→Home', '"\\u001b[F"→End', '"\\u001bOF"→End',
        ]);
    });
});

describe('粘贴专路', () => {
    it('产出 load-buffer + paste-buffer 命令对，顺序固定', () => {
        const cmds = encodePasteCommands(PANE, '/tmp/x/vh-paste-1-abcdef.txt', 'vh-paste-1-abcdef');
        expect(cmds.map((c) => c.kind)).toEqual(['load-buffer', 'paste-buffer']);
        expect(cmds[0].line).toBe("load-buffer -b vh-paste-1-abcdef '/tmp/x/vh-paste-1-abcdef.txt'");
        // -p 让 tmux 按 pane 的真实 2004 状态决定要不要加 bracketed paste 包裹；
        // -d 粘完删 buffer。
        expect(cmds[1].line).toBe('paste-buffer -p -d -b vh-paste-1-abcdef -t %0');
    });

    it('argv 形态可直接 spawn（零 quoting）', () => {
        const cmds = encodePasteCommands(PANE, '/tmp/p f.txt', 'buf1');
        expect(cmds[0].argv).toEqual(['load-buffer', '-b', 'buf1', '/tmp/p f.txt']);
        expect(cmds[1].argv).toEqual(['paste-buffer', '-p', '-d', '-b', 'buf1', '-t', '%0']);
    });

    it('带空格/单引号的路径被正确 quoting', () => {
        const cmds = encodePasteCommands(PANE, "/tmp/it's dir/x.txt", 'buf1');
        expect(cmds[0].line).toBe("load-buffer -b buf1 '/tmp/it'\\''s dir/x.txt'");
    });

    it('空路径/空 buffer 名/含换行一律抛（空行 = detach 的同族纪律）', () => {
        expect(() => encodePasteCommands(PANE, '', 'b')).toThrow(/empty paste file path/);
        expect(() => encodePasteCommands(PANE, '/tmp/x', '')).toThrow(/empty paste buffer name/);
        expect(() => encodePasteCommands(PANE, '/tmp/x\ny', 'b')).toThrow(/newline/);
    });

    it('buffer 名每次都不同（并发粘贴不撞、不与用户 buffer 撞）', () => {
        const names = new Set(Array.from({ length: 200 }, () => nextPasteBufferName()));
        expect(names.size).toBe(200);
        for (const n of names) expect(n).toMatch(/^vh-paste-[0-9a-f]+-[0-9a-f]{6}$/);
    });

    it('buildPastePlan 是纯的：给出要写的字节与路径，不碰盘', () => {
        const plan = buildPastePlan('line1\nline2\n', PANE, { dir: '/tmp/vh', bufferName: 'bufX' });
        expect(plan.bufferName).toBe('bufX');
        expect(plan.path).toBe('/tmp/vh/bufX.txt');
        expect(Buffer.from(plan.bytes).toString('utf8')).toBe('line1\nline2\n');
        expect(plan.commands.map((c) => c.line)).toEqual([
            "load-buffer -b bufX '/tmp/vh/bufX.txt'",
            'paste-buffer -p -d -b bufX -t %0',
        ]);
    });

    it('buildPastePlan 目录带尾斜杠不会产出双斜杠', () => {
        expect(buildPastePlan('x', PANE, { dir: '/tmp/vh/', bufferName: 'b' }).path).toBe('/tmp/vh/b.txt');
    });

    it('多字节/多行文本按 UTF-8 落盘（tmux paste-buffer 负责 \\n→\\r 与 2004 包裹）', () => {
        const plan = buildPastePlan('中文\n😀\n', PANE, { dir: '/tmp/vh', bufferName: 'b' });
        expect([...plan.bytes]).toEqual([...Buffer.from('中文\n😀\n', 'utf8')]);
    });

    it('粘贴命令与 send-keys 命令可拼进同一条 stdin 流（同 FIFO 保序）', () => {
        const plan = buildPastePlan('hello', PANE, { dir: '/tmp/vh', bufferName: 'b' });
        const text = toControlStdin([...plan.commands, ...encodeSendKeys('\r', PANE)]);
        expect(text).toBe(
            "load-buffer -b b '/tmp/vh/b.txt'\npaste-buffer -p -d -b b -t %0\nsend-keys -Ht %0 0d\n",
        );
    });
});
