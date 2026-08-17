#!/usr/bin/env node
/**
 * pane 侧字节捕获对跑 —— 终端通道 v2 写入端（B-121 / spec §D1b）的**硬门**。
 *
 * 为什么要新建一个工具（spec 盲审 A3）
 * ------------------------------------
 * `term-input-goldendiff.mjs` 比的是 **web 侧两条输入路径的 emitted**
 * （`?input=xterm` vs `?input=own`）。对 **daemon→pane** 这一段，它俩走的是同一条
 * `sendInput → terminal-input → daemon.write()`，恒等 ⇒ 拿它当 v2 写入端的门就是
 * **假绿**。v2 换掉的正是 daemon 那一段（`pty.write()` → `send-keys` 命令化），
 * 所以比对面必须挪到 **pane 侧真正落到程序 stdin 的字节**。
 *
 * 怎么比
 * ------
 * 同一串输入字节，分别灌进**隔离**的 tmux 会话（4 条泳道 = 2 路径 × DECCKM 两态）：
 *   旧路径 attach   ：node-pty 起 `tmux attach-session -d`（= v1 现状），`pty.write(bytes)`
 *   新路径 sendkeys ：`tmux -C attach-session`（control mode，pipe），写
 *                     `encodeSendKeys()` 产出的命令行
 * 每个 pane 都压成**落文件的字节水槽**（`stty raw -echo -isig -ixon; cat > <file>`
 * ——B-096 那边是 `> /dev/null`，这里必须落盘才能比对），逐个用例采样落盘字节，
 * **逐字节比对**。142/142 一致才算过。
 *
 * 142 条输入字节序列的来源
 * ------------------------
 * 直接 import `term-input-goldendiff.mjs` 的 `buildScanTable()`（71 项：F1-F12 /
 * 方向键×4 修饰 / 导航 7 / Ctrl+a..z / Ctrl 标点 6 / Tab·Enter·Esc）与 `refEncode()`
 * （把一个用例 + DECCKM 态变成 VT 字节）。**这套表只能有一份实现，不许各抄一遍**
 * （README 的原话）。repo 里没有落盘 golden，所以字节由 `refEncode` 现算——它在
 * 这里只是**激励生成器**，不是期望值：期望值是"另一条路径收到的字节"。
 *
 * ⚠️⚠️ 三条用一轮实测换来的方法学修正（改脚本前先读完）
 * ------------------------------------------------------
 * M1 **pane 的 DECCKM 必须跟着用例走**。v1 的 attach client 不是透明字节管道，
 *    它把收到的字节**解成键、再按 pane 当前模式重新编码**：pane 处于普通光标模式
 *    时喂 `ESC O A`，pane 收到的是 `ESC [ A`（实测）。而 web 的 DECCKM 本来就是
 *    pane 模式的镜像（tmux 把 DECSET 1 透传给 client），所以生产里两者恒同调。
 *    于是 deckm=on 的泳道把水槽写成 `printf '\033[?1h'; cat > f`，让 pane 真的进
 *    application cursor 模式（用 `#{keypad_cursor_flag}` 断言），比对面才是苹果对
 *    苹果。**不做这一步会凭空造出十几条"差异"，全是 harness 自己的锅。**
 * M2 **孤立 ESC 在旧路径上要迟到约 500ms**（实测：写下去 400ms 还没到，1000ms 到）
 *    ——tmux client 的 partial-key 超时。采样窗口必须比它长，否则 ESC 会漏进**下一
 *    条用例**的样本，一错错一串（实测症状：`off|Escape` 空、`on|F1` 多一个 1b）。
 *    所以 attach 泳道的静默判定窗口是 750ms，sendkeys 泳道（命令直投，无此延迟）
 *    250ms。慢是应该的，这是硬门不是 CI。
 * M3 **tmux 默认 prefix `C-b` 会吃掉扫描表里的 `Ctrl+b`**（0x02），而且会把紧随其
 *    后的按键当 tmux 命令解释（可能开窗/detach，污染整轮）。默认两条路径都
 *    `set prefix None` 把比对面收敛到编码层；`--keep-prefix` 可以复现并量化那条
 *    差异（报告里单独列，不会被抹掉）。
 *
 * 纪律
 * ----
 *  - **隔离 socket**：所有 tmux 调用都经 `tx()` 注入 `-L b121-p0b`，一次都不碰默认
 *    socket（本机是 mac-office，默认 socket 上跑着 Owner 的生产 daemon 与真实工作
 *    会话 `vh-*`）。`finally` 里 `kill-server` 清干净，SIGINT 也清。
 *  - **不进 CI**，按批手跑（同 scripts/probe 的定位）。整轮约 2-3 分钟。
 *  - 退出码：`0` 全一致 · `1` 有差异 · `2` 跑不出结论。**2 绝不当 0 用。**
 *
 * 用法
 * ----
 *   node scripts/probe/term-sendkeys-bytecmp.mjs
 *   node scripts/probe/term-sendkeys-bytecmp.mjs --keep-prefix   # 保留默认 C-b prefix
 *   node scripts/probe/term-sendkeys-bytecmp.mjs --filter 'Ctrl' # 只跑匹配 id 的用例
 *   node scripts/probe/term-sendkeys-bytecmp.mjs -v              # 打印全部用例
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildScanTable, refEncode } from './term-input-goldendiff.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 参数 / 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 隔离 socket 名。**绝不为空、绝不改成默认 socket。** */
const SOCKET = 'b121-p0b';
const WORK_DIR = '/tmp/vh-sendkeys-bytecmp';
const COLS = 80;
const ROWS = 24;
const POLL_MS = 25;
/** 静默判定窗口：attach 要盖住 M2 的 ~500ms 孤立 ESC 延迟；sendkeys 无此延迟。 */
const IDLE_MS = { attach: 750, sendkeys: 250 };
const SETTLE_MAX_MS = 4000;

function parseArgs(argv) {
    const o = { keepPrefix: false, filter: null, verbose: false, help: false, normalize: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--keep-prefix') o.keepPrefix = true;
        else if (a === '--normalize') o.normalize = true;
        else if (a === '--raw-keys') o.normalize = false;
        else if (a === '--filter') o.filter = new RegExp(argv[++i]);
        else if (a === '-v' || a === '--verbose') o.verbose = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else throw new Error(`未知参数：${a}`);
    }
    return o;
}

// ═══════════════════════════════════════════════════════════════════════════
// tmux（**只在隔离 socket 上**）
// ═══════════════════════════════════════════════════════════════════════════

/** 唯一的 tmux 入口：强制 `-L SOCKET`，杜绝手滑打到默认 socket 的生产会话上。 */
function tx(...args) {
    return spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
}

function killServer() {
    try { tx('kill-server'); } catch { /* 没起来就没得杀 */ }
}

/**
 * 起一个隔离会话，pane 压成落文件的字节水槽。
 * `appCursor` 让 pane 进/出 application cursor 模式（M1）——旧路径按 pane 模式
 * 重编码方向键，不对齐就全是假差异。
 */
async function makeSinkSession(name, { keepPrefix, appCursor }) {
    const sinkPath = join(WORK_DIR, `${name}.bin`);
    rmSync(sinkPath, { force: true });
    const r = tx('new-session', '-d', '-s', name, '-x', String(COLS), '-y', String(ROWS));
    if (r.status !== 0) throw new Error(`new-session ${name} 失败：${r.stderr.trim()}`);
    tx('set-option', '-t', `=${name}:`, 'status', 'off');
    tx('set-option', '-t', `=${name}:`, 'mouse', 'off');       // 与生产 vh-* 会话同款
    if (!keepPrefix) tx('set-option', '-t', `=${name}:`, 'prefix', 'None');
    // 水槽：raw 模式后 Ctrl+C/D/Z/S 只是普通字节，扫描表里的危险键杀不掉 cat。
    const mode = appCursor ? "printf '\\033[?1h'; " : "printf '\\033[?1l'; ";
    tx('send-keys', '-t', `=${name}:`, '-l', '--',
        `stty raw -echo -isig -ixon 2>/dev/null; ${mode}cat > ${sinkPath}`);
    tx('send-keys', '-t', `=${name}:`, 'Enter');
    for (let i = 0; i < 80 && !existsSync(sinkPath); i++) await sleep(50);
    if (!existsSync(sinkPath)) throw new Error(`${name}: 水槽文件没建起来（cat 没跑？）`);
    await sleep(400);
    const pane = tx('list-panes', '-t', `=${name}:`, '-F', '#{pane_id}').stdout.trim();
    if (!/^%\d+$/.test(pane)) throw new Error(`${name}: 取不到 pane id（拿到 ${JSON.stringify(pane)}）`);
    // M1 断言：pane 真的进了/没进 application cursor 模式。错了就直接 exit 2，
    // 不要拿一堆 harness 自造的差异去污染结论。
    const flag = tx('list-panes', '-t', `=${name}:`, '-F', '#{keypad_cursor_flag}').stdout.trim();
    const want = appCursor ? '1' : '0';
    if (flag !== want) throw new Error(`${name}: keypad_cursor_flag=${flag}，期望 ${want}（printf 没生效？）`);
    return { session: name, pane, sinkPath };
}

const sinkSize = (p) => { try { return statSync(p).size; } catch { return 0; } };

/** 写完之后等 pane 侧字节落定，返回本次新增的字节。 */
async function sampleAfter(sinkPath, from, idleMs) {
    const needIdle = Math.ceil(idleMs / POLL_MS);
    let idle = 0;
    let last = sinkSize(sinkPath);
    const deadline = Date.now() + SETTLE_MAX_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const now = sinkSize(sinkPath);
        if (now === last) { if (++idle >= needIdle) break; } else { idle = 0; last = now; }
    }
    return readFileSync(sinkPath).subarray(from);
}

// ═══════════════════════════════════════════════════════════════════════════
// 两条写入端
// ═══════════════════════════════════════════════════════════════════════════

/** 旧路径：node-pty 起 `tmux attach-session -d`，`pty.write(bytes)`（= v1 现状）。 */
async function makeAttachWriter(session) {
    const { spawn: ptySpawn } = await import('node-pty');
    const proc = ptySpawn('/bin/sh', ['-c', `exec tmux -L ${SOCKET} attach-session -d -t ${session}`], {
        name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: WORK_DIR,
        env: { ...process.env, TERM: 'xterm-256color' },
    });
    let alive = true;
    proc.onExit(() => { alive = false; });
    await sleep(1000);
    if (!alive) throw new Error(`attach 路径（${session}）：pty 客户端起来就死了`);
    return {
        path: 'attach',
        // v1 的 write()：base64 → utf8 字符串 → pty.write（webTerminal.ts:1559-1564）
        write: (bytes) => proc.write(Buffer.from(bytes).toString('utf8')),
        isAlive: () => alive,
        errors: () => [],
        dispose: () => { try { proc.kill(); } catch { /* 已死 */ } },
    };
}

/** 新路径：control mode 客户端 + encodeSendKeys 命令。 */
async function makeSendKeysWriter(session, pane, { normalize = false } = {}) {
    const mod = await import(new URL('../../packages/happy-cli/src/terminal/sendKeysEncoding.ts', import.meta.url));
    const proc = spawn('tmux', ['-L', SOCKET, '-C', 'attach-session', '-t', session], { stdio: ['pipe', 'pipe', 'pipe'] });
    let alive = true;
    let ctrlOut = '';
    proc.stdout.on('data', (d) => { ctrlOut += d.toString('binary'); });
    proc.stderr.on('data', (d) => { ctrlOut += `STDERR:${d.toString('binary')}\n`; });
    proc.on('exit', () => { alive = false; });
    await sleep(800);
    if (!alive) throw new Error(`sendkeys 路径（${session}）：control client 起来就死了`);
    proc.stdin.write(`refresh-client -C ${COLS}x${ROWS}\n`);
    await sleep(200);
    return {
        path: 'sendkeys',
        write: (bytes) => {
            const cmds = mod.encodeSendKeys(bytes, pane, { normalizeKeyNames: normalize });
            const text = mod.toControlStdin(cmds);   // 内含"绝不裸空行"断言
            if (text) proc.stdin.write(text);
        },
        isAlive: () => alive,
        errors: () => ctrlOut.split('\n').filter((l) => /%error|STDERR:/.test(l)),
        dispose: () => { try { proc.kill('SIGTERM'); } catch { /* 已死 */ } },
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 用例
// ═══════════════════════════════════════════════════════════════════════════

/** 71 项 × DECCKM 两态 = 142 条输入字节序列。 */
export function buildByteCases({ filter = null } = {}) {
    const table = buildScanTable();
    const cases = [];
    for (const deckm of [false, true]) {
        for (const kase of table) {
            if (filter && !filter.test(kase.id)) continue;
            cases.push({
                id: kase.id,
                group: kase.group,
                deckm,
                key: `${deckm ? 'on' : 'off'}|${kase.id}`,
                bytes: Buffer.from(refEncode(kase, deckm), 'utf8'),
            });
        }
    }
    return cases;
}

const hex = (b) => (b.length ? Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim() : '(空)');

/** 一条泳道跑完它那一半用例，返回 key → Buffer。 */
async function runLane(lane, cases, onProgress) {
    const idleMs = IDLE_MS[lane.writer.path];
    const out = new Map();
    // 通道活性探针：一个可打印字节必须落地，否则后面那堆"两边都空"就是假绿。
    let cursor = sinkSize(lane.sinkPath);
    lane.writer.write(Buffer.from('A', 'utf8'));
    const probe = await sampleAfter(lane.sinkPath, cursor, idleMs);
    if (probe.length === 0) throw new Error(`${lane.name}: 探针字节没落到 pane（通道死）`);
    cursor += probe.length;
    for (const c of cases) {
        if (!lane.writer.isAlive()) throw new Error(`${lane.name}: 客户端在用例 ${c.key} 之前就死了`);
        lane.writer.write(c.bytes);
        const got = await sampleAfter(lane.sinkPath, cursor, idleMs);
        cursor += got.length;
        out.set(c.key, Buffer.from(got));
        onProgress?.(c);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════

const HELP = `pane 侧字节捕获对跑（B-121 D1b 硬门）

  node scripts/probe/term-sendkeys-bytecmp.mjs [--keep-prefix] [--filter <re>] [-v]

  旧路径（node-pty + tmux attach + pty.write）与新路径（tmux -C + send-keys 编码）
  各自往隔离会话打同一串字节，比对 pane 侧落盘的字节。142/142 一致才算过。
  全程只用隔离 socket 'tmux -L ${SOCKET}'，不碰默认 socket 上的生产 vh-* 会话。

  --keep-prefix  保留 tmux 默认 prefix C-b（默认设成 None，见文件头 M3）
  --normalize    （默认已开）encodeSendKeys 的 normalizeKeyNames：Home/End 改发 tmux
                 键名，与 v1 的 pane 侧字节一致。**默认必须与生产写入端一致**——
                 webTerminal.write() 传的就是 normalizeKeyNames:true，默认值跟着它走，
                 否则这道硬门会永远报一个与生产无关的假红。
  --raw-keys     关掉归一化（= spec 定稿的纯三通道），用来当场量化那 4 条 Home/End
                 差异，见 TMUX_KEY_NAME_ALIASES 注释
  --filter <re>  只跑 id 匹配的用例（调试用；子集不构成硬门结论，退出码强制 2）
  -v             打印全部用例

  退出码：0 全一致 · 1 有差异 · 2 跑不出结论（2 绝不当 0 用）`;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return 0; }

    mkdirSync(WORK_DIR, { recursive: true });
    const cases = buildByteCases({ filter: opts.filter });
    console.error(`用例：${cases.length} 条（71 项 × DECCKM 两态；来源 term-input-goldendiff 的扫描表）`);
    if (cases.length === 0) { console.error('过滤后没有用例。'); return 2; }

    const lanes = [];
    let exitCode = 2;
    let report = null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const onSigint = () => { killServer(); process.exit(2); };
    process.on('SIGINT', onSigint);

    try {
        killServer();                       // 上一轮的残骸（只在隔离 socket 上）
        await sleep(300);
        for (const path of ['attach', 'sendkeys']) {
            for (const appCursor of [false, true]) {
                const name = `bytecmp-${path}-${appCursor ? 'on' : 'off'}`;
                const s = await makeSinkSession(name, { keepPrefix: opts.keepPrefix, appCursor });
                const writer = path === 'attach'
                    ? await makeAttachWriter(s.session)
                    : await makeSendKeysWriter(s.session, s.pane, { normalize: opts.normalize });
                lanes.push({ name, path, deckm: appCursor, writer, sinkPath: s.sinkPath, pane: s.pane });
            }
        }
        console.error(`4 条泳道就绪（prefix=${opts.keepPrefix ? 'C-b(默认)' : 'None'}，normalizeKeyNames=${opts.normalize}）：${lanes.map((l) => l.name).join(' / ')}`);

        const results = new Map();          // `${path}|${key}` -> Buffer
        for (const lane of lanes) {
            const mine = cases.filter((c) => c.deckm === lane.deckm);
            const t0 = Date.now();
            const got = await runLane(lane, mine, (c) => {
                if (process.stderr.isTTY) process.stderr.write(`\r  ${lane.name}: ${c.key}${' '.repeat(24)}`);
            });
            if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(70)}\r`);
            for (const [k, v] of got) results.set(`${lane.path}|${k}`, v);
            console.error(`  ${lane.name}: ${mine.length} 条，${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }

        const ctrlErrors = lanes.flatMap((l) => l.writer.errors());

        const rows = cases.map((c) => {
            const a = results.get(`attach|${c.key}`) ?? Buffer.alloc(0);
            const b = results.get(`sendkeys|${c.key}`) ?? Buffer.alloc(0);
            return {
                key: c.key, id: c.id, group: c.group, deckm: c.deckm,
                sent: c.bytes.toString('hex'),
                attach: a.toString('hex'),
                sendkeys: b.toString('hex'),
                equal: a.equals(b),
                bothEmpty: a.length === 0 && b.length === 0,
            };
        });
        const mismatches = rows.filter((r) => !r.equal);
        const bothEmpty = rows.filter((r) => r.equal && r.bothEmpty);

        // ── 报告 ────────────────────────────────────────────────────────────
        console.error(`\n用例 ${rows.length} · 一致 ${rows.length - mismatches.length} · 不一致 ${mismatches.length} · 两边都空 ${bothEmpty.length}`);
        if (opts.verbose) {
            for (const r of rows) {
                console.error(`  ${r.equal ? '✓' : '✗'} ${r.key.padEnd(22)} sent=${hex(Buffer.from(r.sent, 'hex'))}  ` +
                    `attach=${hex(Buffer.from(r.attach, 'hex'))}  sendkeys=${hex(Buffer.from(r.sendkeys, 'hex'))}`);
            }
        } else if (mismatches.length) {
            console.error('\n差异：');
            for (const r of mismatches) {
                console.error(`  ✗ ${r.key.padEnd(22)} sent    = ${hex(Buffer.from(r.sent, 'hex'))}`);
                console.error(`      ${' '.repeat(22)} attach  = ${hex(Buffer.from(r.attach, 'hex'))}`);
                console.error(`      ${' '.repeat(22)} sendkeys= ${hex(Buffer.from(r.sendkeys, 'hex'))}`);
            }
        }
        if (bothEmpty.length) {
            console.error(`\n⚠️ 两边都空（"一致"但很可能是假绿）：${bothEmpty.map((r) => r.key).join(', ')}`);
        }
        if (ctrlErrors.length) console.error(`\n⚠️ control 通道报错：\n  ${ctrlErrors.join('\n  ')}`);

        report = {
            meta: {
                at: new Date().toISOString(), socket: SOCKET,
                tmux: spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout.trim(),
                node: process.version, platform: process.platform,
                prefix: opts.keepPrefix ? 'C-b' : 'None', normalizeKeyNames: opts.normalize,
                total: rows.length, mismatches: mismatches.length, bothEmpty: bothEmpty.length,
            },
            rows,
        };

        // ── 判决（结论性优先于"绿"）────────────────────────────────────────
        if (opts.filter) {
            console.error('\n--filter 跑的是子集，不构成硬门结论 ⇒ exit 2。');
            exitCode = 2;
        } else if (rows.length !== 142) {
            console.error(`\n结论不成立：期望 142 条用例，实际 ${rows.length} —— 扫描表变了？exit 2。`);
            exitCode = 2;
        } else if (ctrlErrors.length) {
            console.error('\ncontrol 通道有报错，结论不可信 ⇒ exit 2。');
            exitCode = 2;
        } else if (bothEmpty.length > rows.length * 0.2) {
            console.error(`\n两边都空的用例过多（${bothEmpty.length}/${rows.length}）—— 多半是通道死了而不是真一致 ⇒ exit 2。`);
            exitCode = 2;
        } else {
            exitCode = mismatches.length === 0 ? 0 : 1;
            console.error(exitCode === 0 ? `\n✅ ${rows.length}/${rows.length} 逐字节一致。` : `\n❌ ${mismatches.length}/${rows.length} 条不一致。`);
        }
    } catch (e) {
        console.error(`\n跑不出结论：${e.message}`);
        if (opts.verbose && e.stack) console.error(e.stack);
        exitCode = 2;
    } finally {
        for (const l of lanes) { try { l.writer.dispose(); } catch { /* 已死 */ } }
        await sleep(400);
        killServer();                        // 隔离 socket 上的一切，一并清掉
        process.off('SIGINT', onSigint);
        if (report) {
            const out = join(WORK_DIR, `bytecmp-${stamp}.json`);
            writeFileSync(out, JSON.stringify(report, null, 2));
            console.error(`原始结果：${out}`);
        }
    }
    return exitCode;
}

// 纯函数（用例表）要能被 import 复用/单测，import 一下就把整轮跑起来是不可接受的。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
