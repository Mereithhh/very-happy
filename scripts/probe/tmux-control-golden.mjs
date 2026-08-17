#!/usr/bin/env node
/**
 * tmux-control-golden.mjs —— B-121 Phase 0a：录制 tmux control mode 金样本
 *
 * 给 `packages/happy-cli/src/terminal/controlModeDecoder.ts` 生成**真实录制**的
 * 回放样本。每个场景产出三个文件（落在
 * `packages/happy-cli/src/terminal/__fixtures__/controlmode/`）：
 *
 *   <name>.bin            control client stdout 的**原始字节**（一个字节不改）
 *   <name>.truth.json     录制环境 + 与解码器无关的**独立断言**（喂进 pane 的
 *                         确切字节 / 必须出现的标记 / 块数量下界）
 *   <name>.expected.json  用解码器算出的事件摘要（回归基线）
 *
 * `.expected.json` 是解码器自己算的 —— 单独看它等于自证。所以 `bless` 只在
 * `.truth.json` 里那些**独立于解码器**的断言全部通过时才肯写。真正的回归价值
 * 来自测试里的「同一 .bin 任意切分点重放结果必须一致」。
 *
 * ## 用法
 *
 *   node scripts/probe/tmux-control-golden.mjs                 # record + bless 全部场景
 *   node scripts/probe/tmux-control-golden.mjs record          # 只录
 *   node scripts/probe/tmux-control-golden.mjs bless           # 只按现有 .bin 重算 expected
 *   node scripts/probe/tmux-control-golden.mjs record --only cjk,binary
 *   node scripts/probe/tmux-control-golden.mjs --list
 *
 * ## 安全纪律（硬性，踩过事故）
 *
 * 全程只用隔离 socket `tmux -L b121-p0a`，**绝不碰默认 socket 上的生产 vh-* 会话**
 * （这台 mac-office 跑着 Owner 的生产 daemon 和真实工作会话）。脚本 finally 里
 * `tmux -L b121-p0a kill-server`，SIGINT 同样清理。
 *
 * ## 版本注记
 *
 * 本机 tmux 客户端 3.7b；隔离 socket 上起的也是 3.7b server。默认 socket 上的
 * 现役 server 仍是 3.6b 代码，3.6b 二进制已不在本机 —— 主 agent 2026-08-17 用
 * 3.6b 现役 server 与 3.7b 隔离 socket 双跑同一批命令，**协议行结构逐行一致**
 * （只有 session/pane/命令编号不同）。解码器不得依赖任何版本特有形状。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT_DIR = join(REPO, 'packages/happy-cli/src/terminal/__fixtures__/controlmode');
const DECODER = join(REPO, 'packages/happy-cli/src/terminal/controlModeDecoder.ts');

/** Isolated socket — never the default one (production vh-* sessions live there). */
const SOCKET = 'b121-p0a';
const SESSION = 'golden';
const COLS = 80;
const ROWS = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── isolated tmux plumbing ──────────────────────────────────────────────────

function tmux(...args) {
    return new Promise((resolve_) => {
        const p = spawn('tmux', ['-L', SOCKET, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => resolve_({ code, out: out.trim(), err: err.trim() }));
    });
}

async function killServer() {
    await tmux('kill-server');
    await sleep(250);
}

/**
 * One recording: a fresh isolated server + a `/bin/sh` session with a fixed
 * prompt (deterministic-ish output), plus a control client whose stdout is
 * captured byte-for-byte.
 */
async function withRecorder(fn) {
    await killServer();
    const created = await tmux(
        'new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS), '-c', '/tmp',
        "env 'PS1=vh$ ' /bin/sh",
    );
    if (created.code !== 0) throw new Error(`new-session failed: ${created.err}`);
    await sleep(400);

    const cc = spawn('tmux', ['-L', SOCKET, '-C', 'attach-session', '-t', SESSION], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let closed = false;
    cc.stdout.on('data', (d) => chunks.push(d));
    cc.stderr.on('data', (d) => process.stderr.write(`[cc stderr] ${d}`));
    cc.on('close', () => { closed = true; });

    const rec = {
        /** Write one control-mode command line (never a bare empty line: that detaches). */
        send(line) {
            if (line.trim().length === 0) throw new Error('refusing to write an empty control line (= detach)');
            cc.stdin.write(`${line}\n`);
        },
        /** Type literal text into the pane, then Enter. */
        async type(text, settle = 700) {
            rec.send(`send-keys -t %0 -l '${text}'`);
            rec.send('send-keys -t %0 Enter');
            await sleep(settle);
        },
        async keys(...names) {
            rec.send(`send-keys -t %0 ${names.join(' ')}`);
            await sleep(500);
        },
        sleep,
        /** Wait until no stdout byte has arrived for `quietMs` (or `maxMs` elapses). */
        async quiet(quietMs = 500, maxMs = 20000) {
            const started = Date.now();
            let seen = chunks.length;
            let lastChange = Date.now();
            for (;;) {
                await sleep(100);
                if (chunks.length !== seen) { seen = chunks.length; lastChange = Date.now(); }
                if (Date.now() - lastChange >= quietMs) return;
                if (Date.now() - started >= maxMs) return;
            }
        },
    };

    try {
        await rec.quiet(400, 4000);
        const truth = await fn(rec);
        rec.send('detach-client');
        await rec.quiet(400, 5000);
        cc.kill('SIGTERM');
        await sleep(300);
        if (!closed) cc.kill('SIGKILL');
        return { stream: Buffer.concat(chunks), truth };
    } finally {
        try { cc.kill('SIGKILL'); } catch { /* already gone */ }
        await killServer();
    }
}

// ── scenarios ───────────────────────────────────────────────────────────────

const CJK_TEXT = '中文测试 —— 你好，世界！絵文字 🌏🐟 混排 ok\n';

/**
 * Byte-exact pane output: `stty raw -echo` kills OPOST (no LF→CRLF translation)
 * and signal generation, so whatever the next command writes reaches %output
 * verbatim — that is what makes the sidecar-bytes assertion meaningful.
 *
 * It MUST be one shell line (`stty raw …; cmd; stty sane`): an interactive
 * bash/sh re-imposes readline's own termios at every prompt, so a separate
 * `stty raw` line would be undone before the payload command ever runs.
 */
const rawLine = (cmd) => `stty raw -echo; ${cmd}; stty sane`;

const SCENARIOS = [
    {
        name: 'shell',
        description: '普通 shell 会话：若干命令、prompt 重绘、SGR、tab',
        async run(rec) {
            await rec.type('echo hello world');
            await rec.type('printf "a\\tb\\n"');
            await rec.type('ls -1 /usr');
            await rec.type('echo done');
            await rec.quiet();
            return { markers: ['hello world', 'done'] };
        },
    },
    {
        name: 'cjk',
        description: 'CJK/emoji：先普通 echo（真实折行/宽度），再 raw 模式逐字节透传',
        async run(rec, ctx) {
            await rec.type('echo 中文测试 你好世界');
            await rec.quiet();
            ctx.embedded = Buffer.from(CJK_TEXT, 'utf8');
            writeFileSync('/tmp/vh-golden-cjk.bin', ctx.embedded);
            await rec.type(rawLine('cat /tmp/vh-golden-cjk.bin'));
            await rec.quiet();
            return { embedded: true, markers: [] };
        },
    },
    {
        name: 'altscreen',
        description: 'alt 屏进出：less 打开/翻页/退出，验证 \\033[?1049h/l 原样透传',
        async run(rec) {
            const lines = Array.from({ length: 200 }, (_, i) => `alt-line-${i + 1}`).join('\n');
            writeFileSync('/tmp/vh-golden-less.txt', `${lines}\n`);
            await rec.type('less /tmp/vh-golden-less.txt', 1200);
            await rec.quiet(600, 8000);
            await rec.keys('Space');
            await rec.quiet(600, 8000);
            rec.send('list-panes -F "#{pane_id} alternate_on=#{alternate_on}"');
            await rec.quiet(400, 5000);
            await rec.keys('q');
            await rec.quiet(600, 8000);
            // \033[?1049h and \033[?1049l must survive the octal unescaping.
            return { markers: [], containsHex: ['1b5b3f3130343968', '1b5b3f313034396c'] };
        },
    },
    {
        name: 'burst',
        description: 'burst：raw 模式 seq 1 5000，验证合并 %output 与长行',
        async run(rec) {
            await rec.type(rawLine('seq 1 5000'), 200);
            await rec.quiet(800, 30000);
            return { markers: [], seqRange: [1, 5000] };
        },
    },
    {
        name: 'binary',
        description: '二进制：raw 模式 cat 2048 字节 urandom，验证非法 UTF-8 不被破坏',
        async run(rec, ctx) {
            ctx.embedded = randomBytes(2048);
            writeFileSync('/tmp/vh-golden-rnd.bin', ctx.embedded);
            await rec.type(rawLine('cat /tmp/vh-golden-rnd.bin'), 200);
            await rec.quiet(800, 20000);
            return { embedded: true, markers: [] };
        },
    },
    {
        name: 'commands',
        description: '命令块：capture-pane / list-panes / refresh-client / 错误块 / 块体内假 %end',
        async run(rec) {
            await rec.type('echo block-scenario');
            // Colour: `capture-pane -e` puts the SGR escapes in the block body as
            // RAW bytes (ESC is not octal-escaped there, unlike in %output) — the
            // two-encodings-in-one-stream fact the decoder exists to handle.
            await rec.type('printf "\\033[31mRED\\033[0m\\n"');
            await rec.quiet();
            rec.send('capture-pane -peqJN -S -50');
            await rec.quiet(400, 8000);
            rec.send('list-panes -F "#{pane_id} #{alternate_on} #{cursor_x} #{cursor_y} #{pane_current_command}"');
            await rec.quiet(400, 5000);
            rec.send('refresh-client -C 100x30');
            await rec.quiet(600, 8000);
            // A block body containing a line that LOOKS like a terminator: only an
            // exact (epoch, cmdNum) match may close the block.
            rec.send('set-buffer -b vhgold "before\\n%end 1 2 3\\n%error 4 5 6\\nafter"');
            await rec.quiet(300, 5000);
            rec.send('show-buffer -b vhgold');
            await rec.quiet(400, 5000);
            rec.send('this-command-does-not-exist');
            await rec.quiet(400, 5000);
            rec.send('refresh-client -C 80x24');
            await rec.quiet(600, 8000);
            return {
                markers: ['block-scenario'],
                expectErrorBlock: true,
                expectFakeGuardBody: true,
                expectRawEscInBlock: true,
            };
        },
    },
    {
        name: 'claude-tui',
        description: '真实 claude TUI 片段（alt 屏 + 重绘，不提交 prompt、不调 API）',
        optional: true,
        async run(rec) {
            await rec.type('command -v claude', 800);
            await rec.quiet(400, 5000);
            await rec.type('claude', 1500);
            await rec.quiet(1500, 30000);
            await rec.keys('C-c');
            await rec.quiet(600, 8000);
            await rec.keys('C-c');
            await rec.quiet(800, 8000);
            return { markers: [] };
        },
    },
];

// ── record ──────────────────────────────────────────────────────────────────

async function serverVersion() {
    const r = await tmux('display-message', '-p', '#{version}');
    return r.code === 0 && r.out ? `tmux ${r.out}` : 'unknown';
}

async function clientVersion() {
    return new Promise((r) => {
        const p = spawn('tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let o = '';
        p.stdout.on('data', (d) => { o += d; });
        p.on('close', () => r(o.trim() || 'unknown'));
    });
}

async function record(names) {
    mkdirSync(OUT_DIR, { recursive: true });
    const cver = await clientVersion();
    for (const sc of SCENARIOS) {
        if (names.length > 0 && !names.includes(sc.name)) continue;
        process.stdout.write(`\n▶ recording ${sc.name} — ${sc.description}\n`);
        const ctx = {};
        let result;
        try {
            result = await withRecorder(async (rec) => {
                const t = await sc.run(rec, ctx);
                return t;
            });
        } catch (e) {
            if (sc.optional) {
                process.stdout.write(`  ⚠ optional scenario failed, skipped: ${e.message}\n`);
                continue;
            }
            throw e;
        }
        const sver = 'tmux 3.7b (isolated socket; server killed after recording)';
        const truth = {
            scenario: sc.name,
            description: sc.description,
            recordedAt: new Date().toISOString(),
            env: {
                tmuxClient: cver,
                tmuxServer: sver,
                socket: SOCKET,
                geometry: `${COLS}x${ROWS}`,
                shell: "env 'PS1=vh$ ' /bin/sh",
                platform: process.platform,
                node: process.version,
                note: '3.6b/3.7b 协议行结构实测一致（主 agent 2026-08-17 双跑）',
            },
            streamBytes: result.stream.length,
            streamSha256: sha256(result.stream),
            assert: {
                /** UTF-8 substrings that must appear in the decoded pane output. */
                markers: result.truth.markers ?? [],
                /** Hex byte sequences that must appear contiguously. */
                containsHex: result.truth.containsHex ?? [],
                /** `<name>.embedded.bin` must appear contiguously in decoded output. */
                embedded: Boolean(result.truth.embedded),
                /** `seq a b` output: every number a..b must appear in order. */
                seqRange: result.truth.seqRange ?? null,
                /** At least one block closed by `%error`. */
                expectErrorBlock: Boolean(result.truth.expectErrorBlock),
                /** A block body containing a look-alike `%end`/`%error` line that
                 *  must NOT have closed the block. */
                expectFakeGuardBody: Boolean(result.truth.expectFakeGuardBody),
                /** At least one block body carries a RAW 0x1b (block bodies are
                 *  unescaped, unlike %output payloads). */
                expectRawEscInBlock: Boolean(result.truth.expectRawEscInBlock),
                /** The attach greeting: first block, empty, flags=0 (unsolicited). */
                expectGreeting: true,
            },
        };
        writeFileSync(join(OUT_DIR, `${sc.name}.bin`), result.stream);
        if (ctx.embedded) writeFileSync(join(OUT_DIR, `${sc.name}.embedded.bin`), ctx.embedded);
        writeFileSync(join(OUT_DIR, `${sc.name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
        process.stdout.write(`  ✓ ${result.stream.length} bytes → ${sc.name}.bin\n`);
    }
}

// ── bless ───────────────────────────────────────────────────────────────────

/** Run the decoder over a whole stream and build the summary + raw material. */
export function summarize(ControlModeDecoder, stream, chunkSizes) {
    const dec = new ControlModeDecoder();
    const events = [];
    let i = 0, k = 0;
    while (i < stream.length) {
        const size = chunkSizes ? Math.max(1, chunkSizes[k++ % chunkSizes.length]) : stream.length;
        events.push(...dec.push(stream.subarray(i, Math.min(stream.length, i + size))));
        i += size;
    }
    events.push(...dec.flush());

    const panes = new Map();
    const all = [];
    const blocks = [];
    const notifications = [];
    const protocolErrors = [];
    for (const ev of events) {
        if (ev.type === 'output') {
            all.push(ev.data);
            if (!panes.has(ev.pane)) panes.set(ev.pane, []);
            panes.get(ev.pane).push(ev.data);
        } else if (ev.type === 'block') {
            blocks.push({
                epoch: ev.epoch, cmdNum: ev.cmdNum, flags: ev.flags,
                solicited: ev.solicited, error: ev.error,
                bodyBytes: ev.body.length, bodySha256: sha256(ev.body), truncated: ev.truncated,
            });
        } else if (ev.type === 'notification') {
            notifications.push({ name: ev.name, args: ev.args });
        } else {
            protocolErrors.push({ reason: ev.reason, detail: ev.detail });
        }
    }
    const allBytes = Buffer.concat(all);
    const summary = {
        eventCounts: {
            output: all.length,
            block: blocks.length,
            notification: notifications.length,
            protocolError: protocolErrors.length,
        },
        output: {
            totalBytes: allBytes.length,
            sha256: sha256(allBytes),
            panes: Object.fromEntries([...panes.entries()].sort().map(([p, list]) => {
                const b = Buffer.concat(list);
                return [p, { bytes: b.length, sha256: sha256(b) }];
            })),
        },
        blocks,
        notifications,
        protocolErrors,
    };
    return { summary, events, outputBytes: allBytes, blockBodies: events.filter((e) => e.type === 'block') };
}

/** Independent-of-the-decoder checks. Throws on failure — bless refuses to write. */
export function checkTruth(truth, result, dir) {
    const text = result.outputBytes.toString('utf8');
    const fail = (m) => { throw new Error(`[${truth.scenario}] truth check failed: ${m}`); };

    for (const m of truth.assert.markers) {
        if (!text.includes(m)) fail(`decoded output missing marker ${JSON.stringify(m)}`);
    }
    for (const hex of truth.assert.containsHex) {
        if (result.outputBytes.indexOf(Buffer.from(hex, 'hex')) < 0) fail(`decoded output missing byte sequence ${hex}`);
    }
    if (truth.assert.embedded) {
        const embedded = readFileSync(join(dir, `${truth.scenario}.embedded.bin`));
        if (result.outputBytes.indexOf(embedded) < 0) {
            fail(`the ${embedded.length} bytes fed into the pane do not appear contiguously in the decoded output`);
        }
    }
    if (truth.assert.seqRange) {
        const [a, b] = truth.assert.seqRange;
        let at = 0;
        for (let n = a; n <= b; n++) {
            const idx = text.indexOf(`\n${n}\n`, at);
            if (idx < 0) fail(`seq output lost ${n}`);
            at = idx + 1;
        }
    }
    if (truth.assert.expectErrorBlock && !result.summary.blocks.some((b) => b.error)) {
        fail('expected at least one %error block');
    }
    if (truth.assert.expectFakeGuardBody) {
        const hit = result.blockBodies.some((b) => b.body.includes('%end 1 2 3') && b.body.includes('after'));
        if (!hit) fail('the look-alike %end line did not stay inside the block body');
    }
    if (truth.assert.expectRawEscInBlock && !result.blockBodies.some((b) => b.body.includes(0x1b))) {
        fail('no block body carried a raw ESC byte — the -e capture did not land');
    }
    if (truth.assert.expectGreeting) {
        const first = result.summary.blocks[0];
        if (!first) fail('no blocks at all');
        if (first.solicited) fail('first block (attach greeting) must be unsolicited (flags=0)');
        if (first.bodyBytes !== 0) fail('attach greeting must be an empty block');
    }
    if (result.summary.protocolErrors.length > 0) {
        fail(`unexpected protocol errors: ${JSON.stringify(result.summary.protocolErrors)}`);
    }
}

async function bless(names) {
    const mod = await import(pathToFileURL(DECODER).href);
    const { ControlModeDecoder } = mod;
    const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.truth.json'));
    for (const f of files) {
        const truth = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8'));
        if (names.length > 0 && !names.includes(truth.scenario)) continue;
        const stream = readFileSync(join(OUT_DIR, `${truth.scenario}.bin`));
        if (sha256(stream) !== truth.streamSha256) throw new Error(`${truth.scenario}.bin does not match truth sha256`);
        const whole = summarize(ControlModeDecoder, stream, null);
        const byOne = summarize(ControlModeDecoder, stream, [1]);
        if (JSON.stringify(whole.summary) !== JSON.stringify(byOne.summary)) {
            throw new Error(`${truth.scenario}: 1-byte chunking changed the result — decoder is not split-safe`);
        }
        checkTruth(truth, whole, OUT_DIR);
        const expected = { scenario: truth.scenario, streamBytes: stream.length, streamSha256: truth.streamSha256, ...whole.summary };
        writeFileSync(join(OUT_DIR, `${truth.scenario}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`);
        process.stdout.write(`  ✓ blessed ${truth.scenario}: ${JSON.stringify(whole.summary.eventCounts)}\n`);
    }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        return;
    }
    if (argv.includes('--list')) {
        for (const s of SCENARIOS) process.stdout.write(`${s.name}${s.optional ? ' (optional)' : ''} — ${s.description}\n`);
        return;
    }
    const onlyIdx = argv.indexOf('--only');
    const names = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? '').split(',').filter(Boolean) : [];
    const action = argv.find((a) => a === 'record' || a === 'bless') ?? 'all';
    if (!existsSync(DECODER)) throw new Error(`decoder not found: ${DECODER}`);
    if (action === 'record' || action === 'all') await record(names);
    if (action === 'bless' || action === 'all') await bless(names);
    process.stdout.write('\ndone.\n');
}

let interrupted = false;
process.on('SIGINT', async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\nSIGINT — killing isolated tmux server…\n');
    await killServer();
    process.exit(130);
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(async (e) => {
        process.stderr.write(`\n${e.stack || e.message}\n`);
        await killServer();
        process.exit(1);
    });
}
