#!/usr/bin/env node
/**
 * term-burst —— 量一条命令在 web 终端通道上的**传输成本**（B-335）。
 *
 * 「终端感觉慢 / 一行一行地画 / 输入框半天出不来」时先跑这个。它在一个隔离的
 * tmux socket 里跑你给的命令，像 daemon 一样挂一个 control client，然后报出真正
 * 决定快慢的两个数：
 *
 *   - **块数**：tmux 是「产出方每 write 一次发一条 `%output`」，daemon 每块各一次
 *     ingest+encrypt+emit。成本是**条数**，不是字节——pi 启动 11.8 KB 正文能拆成
 *     1029 块（中位 9 字节），而 `cat` 同样大的文件只有 70 块。
 *   - **密集段跨度**：按停顿切开的连续绘制时间。**别看首尾跨度**——pi 的首尾是
 *     936ms，其中 865ms 是它自己的进程在启动，真正的绘制只有 71ms。照首尾跨度
 *     下结论会把「传输放大」误判成「源头本来就慢」（2026-09-03 实踩，第一版报告
 *     就是这么写错的）。
 *
 * 判读看**一次绘制的消息条数 + 中位块大小**（不是 msg/s——任何短突发除下来都很大，
 * 40 块的 `cat` 也能算出 1700/s）。几百条 9 字节的块 = 传输放大，你看到的是队列在
 * 排空。合并层见 `packages/happy-cli/src/terminal/outputCoalescer.ts`；机制与实测表
 * 见 `specs/2026-08-terminal-channel-v2.md` B''''。
 *
 * 用法：
 *   node scripts/dev/term-burst.mjs 'pi'
 *   node scripts/dev/term-burst.mjs --cols 151 --rows 51 --settle 9000 'seq 1 3000'
 *
 * 只碰自己的 socket（`$TMPDIR/vh-term-burst-<pid>`），永远不碰用户的 tmux server。
 */
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = Number(args[i + 1]);
    args.splice(i, 2);
    return Number.isFinite(value) ? value : fallback;
};
const COLS = opt('cols', 151);
const ROWS = opt('rows', 51);
/** How long to keep listening after the command is sent. */
const SETTLE_MS = opt('settle', 9000);
/** A gap this long ends a dense segment (i.e. the app stopped painting). */
const GAP_MS = opt('gap', 50);
const COMMAND = args.join(' ').trim();

if (!COMMAND) {
    console.error('usage: term-burst.mjs [--cols N] [--rows N] [--settle MS] [--gap MS] <command>');
    process.exit(2);
}

const SOCKET = join(tmpdir(), `vh-term-burst-${process.pid}`);
const SESSION = 'burst';
const tmux = (...rest) => spawnSync('tmux', ['-S', SOCKET, ...rest], { encoding: 'utf8' });

function cleanup() {
    tmux('kill-server');
    try { rmSync(SOCKET, { force: true }); } catch { /* already gone */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
    console.error('tmux is not available');
    process.exit(2);
}

tmux('new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS), '-c', process.env.HOME ?? '.', process.env.SHELL ?? 'bash');
// Same session options the daemon sets, so the measurement matches production.
tmux('set-option', '-t', `=${SESSION}:`, 'status', 'off');
tmux('set-option', '-w', '-q', '-t', `=${SESSION}:`, 'window-size', 'latest');

const client = spawn('tmux', ['-S', SOCKET, '-C', 'attach-session', '-t', `=${SESSION}:`], { stdio: ['pipe', 'pipe', 'ignore'] });
client.stdin.write(`refresh-client -C ${COLS}x${ROWS}\n`);

/** tmux escapes `%output` payloads as `\\ooo` for bytes < 0x20 and `\\`. */
function unescapeOctal(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0x5c && i + 3 < buf.length) {
            const octal = buf.toString('ascii', i + 1, i + 4);
            if (/^[0-7]{3}$/.test(octal)) { out.push(parseInt(octal, 8)); i += 3; continue; }
        }
        out.push(buf[i]);
    }
    return Buffer.from(out);
}

const chunks = [];
let pending = Buffer.alloc(0);
let firstAt = 0;
client.stdout.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    let nl;
    while ((nl = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        const head = line.toString('latin1');
        if (!head.startsWith('%output ')) continue;
        const bytes = unescapeOctal(line.subarray(head.indexOf(' ', 8) + 1));
        const now = Date.now();
        if (!firstAt) firstAt = now;
        chunks.push({ ms: now - firstAt, n: bytes.length });
    }
});

setTimeout(() => tmux('send-keys', '-t', `=${SESSION}:`, COMMAND, 'Enter'), 400);

setTimeout(() => {
    if (chunks.length === 0) {
        console.log('no %output at all — did the command run?');
        process.exit(1);
    }
    const bytes = chunks.reduce((sum, c) => sum + c.n, 0);
    const sizes = chunks.map((c) => c.n).sort((a, b) => a - b);
    const at = (q) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))];

    const segments = [];
    let current = null;
    for (const chunk of chunks) {
        if (!current || chunk.ms - current.end > GAP_MS) {
            if (current) segments.push(current);
            current = { start: chunk.ms, end: chunk.ms, chunks: 1, bytes: chunk.n };
        } else {
            current.end = chunk.ms; current.chunks += 1; current.bytes += chunk.n;
        }
    }
    if (current) segments.push(current);
    const busiest = segments.reduce((a, b) => (b.chunks > a.chunks ? b : a));
    const span = Math.max(1, busiest.end - busiest.start);

    console.log(`command       ${COMMAND}   (${COLS}x${ROWS})`);
    console.log(`chunks        ${chunks.length}   bytes ${bytes}   median ${at(0.5)}B  p90 ${at(0.9)}B  max ${sizes.at(-1)}B`);
    console.log(`first→last    ${chunks.at(-1).ms}ms   ← do NOT read this as "how long it painted"`);
    console.log(`dense segments (a gap > ${GAP_MS}ms splits):`);
    for (const s of segments) {
        console.log(`  ${String(s.start).padStart(6)}..${String(s.end).padStart(6)}ms  span ${String(s.end - s.start).padStart(5)}ms  chunks ${String(s.chunks).padStart(5)}  bytes ${s.bytes}`);
    }
    const rate = Math.round((busiest.chunks / span) * 1000);
    console.log(`busiest       ${busiest.chunks} chunks in ${span}ms ≈ ${rate} msg/s`);

    // The verdict is the CHUNK COUNT of one paint, not the instantaneous rate:
    // any short burst divides out to a big msg/s (a 38-chunk `cat` reads as
    // 1700/s and is perfectly fine). What costs is how many separate messages
    // the relay and the browser each have to carry — and the shape that
    // produces them is "many tiny writes", so the median size is the second half
    // of the test.
    const median = at(0.5);
    const amplified = busiest.chunks >= 150 && median <= 64;
    console.log(amplified
        ? `\n⚠️  one paint = ${busiest.chunks} messages of a median ${median}B.\n    That is transport amplification, not a slow app: each one is separately\n    ingested, encrypted and emitted, and you watch the queue drain.\n    Merge before ingest(): packages/happy-cli/src/terminal/outputCoalescer.ts`
        : `\n✅ one paint = ${busiest.chunks} messages of a median ${median}B — message count is not the bottleneck here.`);
    process.exit(0);
}, 400 + SETTLE_MS);
