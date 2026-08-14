#!/usr/bin/env node
/**
 * 按键 golden 差分 —— 终端输入路径改造（specs/2026-08-terminal-input-ownership.md）
 * 从 Step 1 推进到 Step 3 的**硬门**。
 *
 * 干什么
 * ------
 * 同一个终端、同一构建、同一台浏览器，分别以 `?input=xterm` 和 `?input=own` 各跑一遍
 * 约 71 项按键扫描表（× DECCKM 开/关两态 = 142 个用例），抓 `window.__vhTermInput.emitted`
 * （实际写入 PTY 的字符串），**逐字节**比对。全一致 exit 0；任何不一致 exit 1；
 * 跑不出结论（通道死了、两条路径没真的分叉、终端没连上）exit 2 —— 绝不用 exit 0 掩盖。
 *
 * 一行用法
 * --------
 *   node scripts/probe/term-input-goldendiff.mjs                     # 真站扫描（默认 happy.mereith.com）
 *   node scripts/probe/term-input-goldendiff.mjs --selftest          # 离线自测（不开浏览器、不碰终端）
 *   VH_USER=... VH_PASS=... node scripts/probe/term-input-goldendiff.mjs   # 首次（profile 里还没登录）
 *
 * 契约（Step 1 提供，本脚本只消费，不改产品代码）
 * ------------------------------------------------
 *   1. URL 参数 `?input=own` / `?input=xterm` 一次性覆盖输入路径（默认 xterm）。
 *   2. `debugMode` 下页面挂 `window.__vhTermInput = { routed: [...], emitted: [...] }`
 *      （环形缓冲 200），`emitted` = 实际写入 PTY 的字符串。
 *   契约没上线时：`--reader=ondata` 用 `term.onData` 兜底（**只对经 xterm 编码器的键有效**，
 *   见下面 READER 一节的告警），`--selftest` 用注入的假读取器把工具本身跑通。
 *
 * ⚠️ 本仓踩过的 CDP 陷阱（都编码进下面的实现里了）
 * ------------------------------------------------
 *  T1  `Input.dispatchKeyEvent` 的 down/up **keyCode 必须配对**，否则浏览器侧残留按键状态
 *      会污染后续用例（会看到莫名其妙的合成 keydown 洪水）。→ `sendKey()` 里 down/up 共用
 *      同一份 windowsVirtualKeyCode/nativeVirtualKeyCode。
 *  T2  **headful 窗口失焦时 dispatchKeyEvent 被静默丢弃**（composition 事件却照常送达）。
 *      这是 round 1 假阴性的根源：两条路径都没收到键 ⇒ "全部一致"的假绿。
 *      → 每个 tab 开头 `Page.bringToFront` + `Emulation.setFocusEmulationEnabled`，
 *        并且**先发一个探针键断言 emitted 有增长**，通道确认活着才开跑（见 assertChannelAlive）。
 *  T3  headless 下 `Input.imeSetComposition` 会污染键状态 ⇒ 本工具不用 IME 输入；
 *      但仍**每轮开新 tab**（一条路径 = 一个 tab）。
 *  T4  **在终端页调 `Page.reload` 会触发 beforeunload 离开确认、阻塞整个 CDP session**
 *      （我们自己加的 ⌘W 保护 closeGuard 的副作用）。→ 全程**不用 reload**；切 `?input=`
 *      一律开新 tab；并挂 `Page.javascriptDialogOpening` 自动处理（beforeunload 放行、
 *      其它一律 dismiss）。
 *  T5  探针在**每次路由变化后必须重装/重取**：WebTerminalScreen 会 remount，读到死实例
 *      会得出全假结论。→ 新 tab 里重跑 FIND_TERM + 装 reader，且 reader 每次读都动态取
 *      `window.__vhTermInput`（不缓存对象引用）。
 *  T6  不要碰 `clipboard.readText`（弹权限框冻结 renderer）。→ 本工具一次都不碰剪贴板。
 *
 * 纪律
 * ----
 *  - 只读扫描，但**扫描会往终端里敲键** ⇒ 新建一个专用测试终端，`finally` 里清理干净：
 *    `tmux kill-session -t vh-<id>` + 写墓碑 `~/.happy/terminal-tombstones.json`
 *    （Owner 被"测试终端复活"坑过，这条是硬要求）。
 *  - 扫描前把终端压成一个**字节水槽**：`stty raw -echo -isig -ixon; cat > /dev/null`。
 *    Ctrl+C/Ctrl+D/Ctrl+Z/Ctrl+S 在 raw 模式下只是普通字节 ⇒ 扫描表里的危险键不会
 *    杀掉 shell、不会挂起、不会执行任何东西（Enter 也只是一个字节）。
 *  - 产物落 /tmp（默认 /tmp/vh-goldendiff/），不往仓库里拉屎。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 参数
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
    const o = {
        base: 'https://happy.mereith.com',
        port: 9227,                                   // 9226 是 ime-diag 那套的，别抢
        profile: '/tmp/vh-goldendiff-profile',
        chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        machine: hostname(),
        reader: 'vh',                                 // vh | ondata
        outDir: '/tmp/vh-goldendiff',
        settle: 140,                                  // 每键等待 emitted 落定的毫秒数
        filter: null,                                 // 只跑 id 匹配这个正则的用例
        selftest: false,
        keepTerminal: false,
        reuseTerminal: null,
        prep: true,
        text: true,                                   // Enter/Tab 带 text（贴近真实 Chrome）
        allowSamePath: false,
        verbose: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--base': case '--url': o.base = next(); break;
            case '--port': o.port = Number(next()); break;
            case '--profile': o.profile = next(); break;
            case '--chrome': o.chrome = next(); break;
            case '--machine': o.machine = next(); break;
            case '--reader': o.reader = next(); break;
            case '--out': o.outDir = next(); break;
            case '--settle': o.settle = Number(next()); break;
            case '--filter': o.filter = new RegExp(next(), 'i'); break;
            case '--selftest': o.selftest = true; break;
            case '--keep-terminal': o.keepTerminal = true; break;
            case '--reuse-terminal': o.reuseTerminal = next(); break;
            case '--no-prep': o.prep = false; break;
            case '--no-text': o.text = false; break;
            case '--allow-same-path': o.allowSamePath = true; break;
            case '-v': case '--verbose': o.verbose = true; break;
            case '-h': case '--help': o.help = true; break;
            default: throw new Error(`未知参数: ${a}`);
        }
    }
    return o;
}

const HELP = `按键 golden 差分（?input=xterm vs ?input=own，逐字节）

  node scripts/probe/term-input-goldendiff.mjs [选项]

  --base <url>          默认 https://happy.mereith.com
  --machine <label>     在哪台机器上开测试终端（默认本机 hostname）
  --reader vh|ondata    vh=window.__vhTermInput.emitted（默认，Step 1 契约）
                        ondata=term.onData 兜底（⚠️ 只覆盖走 xterm 编码器的键）
  --port/--profile      专用 headful Chrome 的调试端口与 user-data-dir（默认 9227 /tmp/vh-goldendiff-profile）
  --filter <regex>      只跑匹配的用例 id（调试用）
  --settle <ms>         每键等待 emitted 落定（默认 140）
  --reuse-terminal <id> 复用已有终端（跳过新建，也跳过清理）
  --keep-terminal       跑完不清理（⚠️ 违反纪律，只在排查时用）
  --no-prep             不把终端压成 raw 模式字节水槽（危险：Ctrl+D 会杀 shell）
  --selftest            离线自测：注入假读取器跑通表/差分/退出码，不开浏览器
  -v                    打印全部用例（默认只打印差异）

  退出码：0=全一致  1=有不一致  2=跑不出结论（通道死/路径没分叉/终端没连上）
  首次登录：VH_USER=... VH_PASS=... （profile 会记住登录态，之后不用再给）`;

// ═══════════════════════════════════════════════════════════════════════════
// 扫描表（spec §可测试性 点名的那批；71 项 × DECCKM 两态 = 142 用例）
// ═══════════════════════════════════════════════════════════════════════════

/** CDP modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8 */
const MOD_BITS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const modBits = (mods) => mods.reduce((a, m) => a | MOD_BITS[m], 0);

export function buildScanTable() {
    const t = [];
    const add = (group, id, key, code, keyCode, mods = [], text) =>
        t.push({ group, id, key, code, keyCode, mods, text });

    // F1-F12（12）
    for (let i = 1; i <= 12; i++) add('function', `F${i}`, `F${i}`, `F${i}`, 111 + i);

    // 方向键 × {无, Ctrl, Shift, Alt}（16）
    for (const [key, kc] of [['ArrowUp', 38], ['ArrowDown', 40], ['ArrowRight', 39], ['ArrowLeft', 37]]) {
        for (const mods of [[], ['Ctrl'], ['Shift'], ['Alt']]) {
            add('arrow', mods.length ? `${mods[0]}+${key}` : key, key, key, kc, mods);
        }
    }

    // 导航/编辑键（7）
    for (const [key, kc] of [['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34],
                             ['Insert', 45], ['Delete', 46], ['Backspace', 8]]) {
        add('nav', key, key, key, kc);
    }

    // Ctrl+a..z（26）—— 在 raw 模式水槽里 Ctrl+C/D/Z/S 都只是普通字节
    for (let c = 97; c <= 122; c++) {
        const ch = String.fromCharCode(c);
        add('ctrl-letter', `Ctrl+${ch}`, ch, `Key${ch.toUpperCase()}`, c - 32, ['Ctrl']);
    }

    // Ctrl+[ ] \ ^ _ Space（6）
    // ^ 和 _ 在 US 布局上是 Ctrl+Shift+6 / Ctrl+Shift+-，按物理和弦发，而不是编造一个
    // 不存在的 keyCode —— 我们要测的就是"真人按下去会怎样"。
    add('ctrl-punct', 'Ctrl+[', '[', 'BracketLeft', 219, ['Ctrl']);
    add('ctrl-punct', 'Ctrl+]', ']', 'BracketRight', 221, ['Ctrl']);
    add('ctrl-punct', 'Ctrl+\\', '\\', 'Backslash', 220, ['Ctrl']);
    add('ctrl-punct', 'Ctrl+^', '^', 'Digit6', 54, ['Ctrl', 'Shift']);
    add('ctrl-punct', 'Ctrl+_', '_', 'Minus', 189, ['Ctrl', 'Shift']);
    add('ctrl-punct', 'Ctrl+Space', ' ', 'Space', 32, ['Ctrl']);

    // Tab / Shift+Tab（2）、Enter / Escape（2）
    add('tab', 'Tab', 'Tab', 'Tab', 9, [], '\t');
    add('tab', 'Shift+Tab', 'Tab', 'Tab', 9, ['Shift'], '\t');
    add('control', 'Enter', 'Enter', 'Enter', 13, [], '\r');
    add('control', 'Escape', 'Escape', 'Escape', 27);

    return t;
}

// ═══════════════════════════════════════════════════════════════════════════
// 扫描执行（会话可注入 —— 浏览器会话 / 自测假会话共用这一个跑法）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * session 接口（这就是"可注入的读取器"的边界）：
 *   preparePath(path) -> Promise<{fingerprint: object}>   路由到 ?input=<path>、装探针、断言通道活着
 *   setCursorKeyMode(on) -> Promise<{ok, mode}>           DECCKM 开/关（term.write('\x1b[?1h'/'\x1b[?1l')）
 *   sendKey(kase) -> Promise<string[] | {emitted, appConsumed}>   发一次按键，返回新增的 emitted 片段
 *                                                          （appConsumed = 这一击被 app 层浮层/快捷键吃掉了）
 *   note?(msg)                                            可选：把提示打给用户
 */
export async function runScan({ session, table, paths = ['xterm', 'own'], deckmStates = [false, true], onProgress }) {
    const results = {};       // path -> `${deckm}|${id}` -> {emitted, joined}
    const fingerprints = {};
    for (const path of paths) {
        const prep = await session.preparePath(path);
        fingerprints[path] = prep?.fingerprint ?? null;
        results[path] = {};
        for (const deckm of deckmStates) {
            await session.setCursorKeyMode(deckm);
            for (const kase of table) {
                const r = await session.sendKey(kase, { deckm, path });
                const emitted = Array.isArray(r) ? r : (r.emitted ?? []);
                const appConsumed = Array.isArray(r) ? false : !!r.appConsumed;
                const joined = emitted.join('');
                results[path][caseKey(deckm, kase.id)] = { emitted, joined, appConsumed };
                onProgress?.({ path, deckm, kase, joined, appConsumed });
            }
        }
    }
    return { results, fingerprints };
}

const caseKey = (deckm, id) => `${deckm ? 'on' : 'off'}|${id}`;

/**
 * 终端**自动回复**的形状 —— 这些字节确实写进了 PTY，但不是按键产生的：
 * OSC 10/11/12 前景背景色回报（远端一问就答）、DA/DA2 设备属性、DSR 光标位置、
 * DEC 1004 焦点上报。实测（2026-08-14）就撞到过一次：某个用例的采样里混进了
 * `ESC]10;rgb:...ESC\ ESC]11;rgb:...ESC\`，把一条本该一致的用例报成了差异。
 * 逐条（一次 onData / 一次 emitted 记录 = 一条）剥离，剥完为空的整条丢掉；
 * 混在真字节里的不动（宁可报出来让人看，也不要偷偷改样本）。
 */
const AUTO_REPLY_RE = /\x1b\]1[0-2];rgb:[0-9a-fA-F/]+(?:\x1b\\|\x07)|\x1b\[\?[0-9;]*c|\x1b\[>[0-9;]*c|\x1b\[[0-9]+;[0-9]+R|\x1b\[0n|\x1b\[[IO]/g;

export function isTerminalAutoReply(s) {
    if (typeof s !== 'string' || s === '') return false;
    return s.replace(AUTO_REPLY_RE, '') === '';
}

/** 逐字节比对两条路径的结果，产出差异表。 */
export function diffResults({ results, table, deckmStates = [false, true], paths = ['xterm', 'own'] }) {
    const [a, b] = paths;
    const rows = [];
    for (const deckm of deckmStates) {
        for (const kase of table) {
            const k = caseKey(deckm, kase.id);
            const ra = results[a]?.[k], rb = results[b]?.[k];
            const va = ra?.joined ?? null, vb = rb?.joined ?? null;
            const appConsumed = !!(ra?.appConsumed || rb?.appConsumed);
            rows.push({
                id: kase.id, group: kase.group, deckm, key: k,
                [a]: va, [b]: vb,
                equal: va === vb,
                appConsumed,
                // 落盘时同时存一份可读转义：JSON.stringify **不转义 0x7f(DEL)**，
                // 直接看 JSON 会把 Backspace 的 \x7f 看成空串（我照着这个坑判错过一次）。
                escaped: { [a]: esc(va), [b]: esc(vb) },
                // 一个用例两边都空 = 很可能两边都没收到（通道死/键被吞），单独标出来，
                // 因为它在"逐字节一致"意义上是通过的，却往往是假绿。
                // 已知是被 app 层吃掉的不算在这里 —— 那个有单独一节，原因清楚。
                bothEmpty: !appConsumed && (va ?? '') === '' && (vb ?? '') === '',
            });
        }
    }
    const mismatches = rows.filter((r) => !r.equal);
    const bothEmpty = rows.filter((r) => r.equal && r.bothEmpty);
    const appConsumed = rows.filter((r) => r.appConsumed);
    return { rows, mismatches, bothEmpty, appConsumed, total: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════════════════════════════════════

function esc(s) {
    if (s === null || s === undefined) return '(未采到)';
    if (s === '') return '(空)';
    return s.replace(/[\x00-\x1f\x7f]/g, (c) => {
        const n = c.charCodeAt(0);
        if (n === 0x1b) return 'ESC';
        if (n === 0x0d) return '\\r';
        if (n === 0x0a) return '\\n';
        if (n === 0x09) return '\\t';
        return '\\x' + n.toString(16).padStart(2, '0');
    });
}

function renderReport(diff, meta, { verbose }) {
    const L = [];
    const [a, b] = meta.paths;
    L.push('');
    L.push(`按键 golden 差分   ${a} ⟷ ${b}`);
    L.push(`  站点     ${meta.base}`);
    L.push(`  终端     vh-${meta.terminalId ?? '?'} @ ${meta.machine}`);
    L.push(`  读取器   ${meta.readerLabel}`);
    L.push(`  扫描表   ${meta.tableSize} 项 × DECCKM ${meta.deckmStates.map((d) => (d ? 'on' : 'off')).join('/')} = ${diff.total} 用例`);
    for (const p of meta.paths) {
        L.push(`  指纹[${p}]  ${JSON.stringify(meta.fingerprints?.[p] ?? null)}`);
    }
    L.push('');

    for (const deckm of meta.deckmStates) {
        const rows = diff.rows.filter((r) => r.deckm === deckm);
        const bad = rows.filter((r) => !r.equal);
        L.push(`── DECCKM=${deckm ? 'on (\\x1b[?1h)' : 'off (\\x1b[?1l)'} ── ${rows.length - bad.length}/${rows.length} 一致`);
        const show = verbose ? rows : bad;
        for (const r of show) {
            const mark = r.equal ? (r.bothEmpty ? '·' : '✔') : '✘';
            L.push(`  ${mark} ${r.id.padEnd(14)} ${a}=${esc(r[a])}${r.equal ? '' : `   ${b}=${esc(r[b])}`}`);
        }
        if (!verbose && bad.length === 0) L.push('     （无差异）');
        L.push('');
    }

    if (diff.appConsumed?.length) {
        L.push(`ℹ️  ${diff.appConsumed.length} 个用例被 **app 层**吃掉（按下去弹了浮层 / 焦点被夺走，`);
        L.push(`    没有任何字节进 PTY；脚本已当场 Esc + 重新聚焦，后续用例未被污染）：`);
        L.push(`    ${[...new Set(diff.appConsumed.map((r) => r.id))].join(', ')}`);
        L.push(`    这不是两条输入路径的差异，是 §C 优先级表 P0（window-capture 快捷键先手）的`);
        L.push(`    实际覆盖面 —— 值得单独确认是有意为之还是匹配器过宽（⌘K/⌘J 连 ctrlKey 一起认？）。`);
        L.push('');
    }
    if (diff.bothEmpty.length) {
        L.push(`⚠️  ${diff.bothEmpty.length} 个用例两边都是空串 —— 逐字节意义上"一致"，但很可能是`);
        L.push(`    两边都没收到键（通道死/被上层吞掉）。逐个确认，别当绿灯：`);
        L.push(`    ${[...new Set(diff.bothEmpty.map((r) => r.id))].join(', ')}`);
        L.push('');
    }

    const okCount = diff.total - diff.mismatches.length;
    L.push(diff.mismatches.length === 0
        ? `结论：${okCount}/${diff.total} 用例逐字节一致 ✅  （Step 1 → Step 3 的按键门通过）`
        : `结论：${diff.mismatches.length}/${diff.total} 用例不一致 ❌  （门未通过，不许推进 Step 3）`);
    return L.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// CDP 客户端（最小实现，零依赖；原型来自本仓 ime-diag round-3 的 cdp.mjs）
// ═══════════════════════════════════════════════════════════════════════════

async function httpJson(url, method = 'GET') {
    const r = await fetch(url, { method });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return text; }
}

export async function ensureChrome(opts) {
    const version = await httpJson(`http://127.0.0.1:${opts.port}/json/version`).catch(() => null);
    if (version && version.Browser) return { launched: false, version: version.Browser };
    mkdirSync(opts.profile, { recursive: true });
    // 独立 user-data-dir：绝不抢别的会话（ime-diag 在 9226）的 profile。
    const child = spawn(opts.chrome, [
        `--remote-debugging-port=${opts.port}`,
        `--user-data-dir=${opts.profile}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const v = await httpJson(`http://127.0.0.1:${opts.port}/json/version`).catch(() => null);
        if (v && v.Browser) return { launched: true, version: v.Browser };
    }
    throw new Error(`Chrome 没起来（port ${opts.port}）`);
}

/** 打开一个新 tab 并连上；返回一个带 evalJs/send 的会话。 */
export async function openTab(port, url) {
    const created = await httpJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 'PUT');
    const target = typeof created === 'object' && created.webSocketDebuggerUrl
        ? created
        : (await httpJson(`http://127.0.0.1:${port}/json`)).filter((t) => t.type === 'page').pop();
    return attach(port, target);
}

export async function attachExisting(port, url) {
    const list = await httpJson(`http://127.0.0.1:${port}/json`);
    const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (page) return attach(port, page);
    return openTab(port, url);
}

async function attach(port, target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
        if (d.method) for (const l of listeners) l(d);
    });
    await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')));
    });
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const on = (fn) => listeners.push(fn);

    await send('Page.enable');
    await send('Runtime.enable');

    // T4：终端页有 beforeunload（closeGuard 的 ⌘W 保护）。挂上自动处理，否则任何
    // 离开动作都会把整个 CDP session 卡死在一个没人点的对话框上。
    on((ev) => {
        if (ev.method === 'Page.javascriptDialogOpening') {
            const t = ev.params?.type;
            // beforeunload：accept=true 才是"确认离开"；其它（alert/confirm/prompt）一律 dismiss。
            send('Page.handleJavaScriptDialog', { accept: t === 'beforeunload' });
        }
    });
    // T2：headful 窗口失焦 ⇒ dispatchKeyEvent 被静默丢弃（round 1 假阴性根源）。
    await send('Target.activateTarget', { targetId: target.id });
    await send('Page.bringToFront');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });

    const evalJs = async (expression, { awaitPromise = true } = {}) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
        const ex = r.result?.exceptionDetails;
        if (ex) throw new Error(`页面求值异常: ${ex.exception?.description ?? ex.text}`.slice(0, 500));
        return r.result?.result?.value;
    };
    const evalJson = async (expression, opts) => {
        const v = await evalJs(expression, opts);
        return typeof v === 'string' ? JSON.parse(v) : v;
    };
    return { target, ws, send, on, evalJs, evalJson, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

export async function closeTab(port, targetId, tab) {
    try { await tab?.send('Page.handleJavaScriptDialog', { accept: true }); } catch { /* 没有对话框 */ }
    tab?.close();
    // Target.closeTarget（走 HTTP /json/close）是强制关闭，不会卡在 beforeunload 上。
    await httpJson(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面侧片段
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 在 React fiber 里找到活着的 xterm 实例，挂到 window.__VHGD_T。
 * T5：**每次路由变化后必须重跑** —— WebTerminalScreen 会 remount，握着旧实例
 * 测出来的一切都是假的（ime-diag 有一轮就是这么废掉的）。
 */
export const FIND_TERM = `(()=>{
  let host = document.querySelector('.xterm');
  if (!host) return 'no .xterm';
  let key = null;
  while (host && !key) {
    key = Object.keys(host).find(k=>k.startsWith('__reactFiber$')) || null;
    if (!key) host = host.parentElement;
  }
  if (!key) return 'no fiber key';
  let f = host[key], hops = 0;
  window.__VHGD_T = null;
  while (f && hops++ < 40) {
    let h = f.memoizedState, hi = 0;
    while (h && hi++ < 80) {
      const s = h.memoizedState;
      if (s && typeof s === 'object' && 'current' in s && s.current && typeof s.current === 'object' && 'raw' in s.current && s.current.raw) window.__VHGD_T = s.current.raw;
      h = h.next;
    }
    f = f.return;
  }
  return window.__VHGD_T ? 'ok' : 'not found';
})()`;

const READERS = {
    /** Step 1 契约：window.__vhTermInput.emitted（实际写进 PTY 的字符串）。 */
    vh: {
        label: 'window.__vhTermInput.emitted（Step 1 契约）',
        install: `(()=>{
  const b = window.__vhTermInput;
  if (!b) return 'missing:window.__vhTermInput（debugMode 没开？或 Step 1 契约还没上线）';
  if (!Array.isArray(b.emitted)) return 'missing:__vhTermInput.emitted 不是数组';
  // 条目形状按契约是字符串；对象形状（{data}/{text}）也接受，免得被无关的形状漂移绊倒。
  const norm = (e) => typeof e === 'string' ? e : (e && (e.data ?? e.text ?? e.s ?? e.d)) ?? '';
  window.__VHGD = {
    kind: 'vh',
    // 动态取全局，不缓存对象引用：remount 后 __vhTermInput 可能被换掉（T5）。
    read: () => ((window.__vhTermInput && window.__vhTermInput.emitted) || []).map(norm),
    clear: () => { try { window.__vhTermInput.emitted.length = 0; return true; } catch (e) { return false; } },
    routedLen: () => ((window.__vhTermInput && window.__vhTermInput.routed) || []).length,
  };
  return 'ok';
})()`,
    },
    /**
     * 兜底读取器：直接钩 term.onData。
     * ⚠️ 只覆盖**经 xterm 编码器**落到 onData 的字节。own 路径里凡是绕开 onData 直接
     *    sendInput 的字节（文本域 diff 那条腿）它看不见 ⇒ 会报出并不存在的差异。
     *    因此只用于契约未上线时把工具本身跑通，不能当 Step 3 的门。
     */
    ondata: {
        label: 'term.onData 兜底（⚠️ 只覆盖走 xterm 编码器的键，不能当门）',
        install: `(()=>{
  const T = window.__VHGD_T; if (!T) return 'missing:__VHGD_T';
  if (window.__VHGD && window.__VHGD.dispose) { try { window.__VHGD.dispose(); } catch (e) {} }
  const buf = [];
  const d = T.onData((x) => buf.push(x));
  window.__VHGD = { kind:'ondata', read:()=>buf.slice(), clear:()=>{ buf.length = 0; return true; },
                    routedLen: () => -1, dispose:()=>d.dispose() };
  return 'ok';
})()`,
    },
};

/**
 * 路径指纹 —— 反"假绿"的关键断言之一：如果两轮的**行为指纹**完全一样，说明 `?input=`
 * 根本没生效（两轮跑的是同一条路径），那么"逐字节一致"毫无意义。
 *
 * ⚠️ `search` 只放在 `url` 里，**绝不进 behavior**：URL 本来就一轮 `input=xterm`
 *   一轮 `input=own`，把它算进指纹的话两轮永远"不同"，这条断言就自宫了
 *   （2026-08-14 第一版就是这么写的，验的时候才发现它从来不会触发）。
 */
const FINGERPRINT = `(()=>{
  const b = window.__vhTermInput;
  const ta = document.querySelector('.xterm-helper-textarea');
  const ae = document.activeElement;
  return JSON.stringify({
    url: location.search,
    behavior: {
      ownInputEls: document.querySelectorAll('.vh-term-input').length,
      hasBuf: !!b,
      bufPath: (b && (b.path ?? b.route ?? b.ownership ?? b.mode)) ?? null,
      activeIsHelperTa: !!ta && ae === ta,
      activeTag: ae ? (ae.tagName + (ae.className ? '.' + String(ae.className).slice(0,40) : '')) : null,
    },
  });
})()`;

// ═══════════════════════════════════════════════════════════════════════════
// 浏览器会话
// ═══════════════════════════════════════════════════════════════════════════

function createBrowserSession(ctx) {
    const { opts, port, termUrl } = ctx;
    let tab = null;
    let tabId = null;
    let desiredDeckm = false;
    let deckmResets = 0;
    let noiseDropped = 0;

    const readMode = async () => tab.evalJson(`JSON.stringify((()=>{ try {
        return window.__VHGD_T._core.coreService.decPrivateModes.applicationCursorKeys;
    } catch (e) { return 'unknown'; } })())`);

    const writeMode = async (on) => tab.evalJson(`new Promise((res)=>{
        const T = window.__VHGD_T;
        T.write(${JSON.stringify(on ? '\x1b[?1h' : '\x1b[?1l')}, () => {
          let mode = null;
          try { mode = T._core.coreService.decPrivateModes.applicationCursorKeys; } catch (e) { mode = 'unknown'; }
          res(JSON.stringify({ ok: true, mode }));
        });
    })`);

    /** 模式设不上时用来回答"到底哪儿不对"（不猜，现场问）。 */
    const modeDiag = async () => tab.evalJson(`JSON.stringify((()=>{
        const T = window.__VHGD_T;
        const live = document.querySelector('.xterm');
        let d = { hasT: !!T, xtermEls: document.querySelectorAll('.xterm').length };
        try { d.elInDoc = !!(T && T.element && document.contains(T.element)); } catch (e) { d.elInDoc = 'err'; }
        try { d.sameAsDom = !!(T && T.element && live && (T.element === live || T.element.contains(live) || live.contains(T.element))); } catch (e) { d.sameAsDom = 'err'; }
        try { d.disposed = !!(T && T._core && T._core._isDisposed); } catch (e) { d.disposed = 'err'; }
        try { d.rows = T.rows; d.cols = T.cols; } catch (e) {}
        try { d.mode = T._core.coreService.decPrivateModes.applicationCursorKeys; } catch (e) { d.mode = 'unknown'; }
        try { d.altBuffer = T.buffer.active.type; } catch (e) {}
        return d;
    })())`);

    /**
     * 写模式 + 校验，最多 5 轮；连续失败时**重取探针**（T5：屏幕 remount 后我们手里
     * 可能是个已 dispose 的死实例，写进去石沉大海，callback 照样回调）。
     */
    const applyMode = async (on) => {
        let last = null;
        for (let i = 1; i <= 5; i++) {
            last = await writeMode(on);
            if (last.mode === 'unknown' || last.mode === on) return last;
            await sleep(250);
            if (i === 2) {   // 两次不成 ⇒ 怀疑握着死实例，重取
                await tab.evalJs(FIND_TERM);
                await tab.evalJs(READERS[opts.reader].install);
            }
        }
        last.diag = await modeDiag();
        return last;
    };

    const installProbe = async () => {
        const found = await tab.evalJs(FIND_TERM);
        if (found !== 'ok') throw new Error(`找不到活着的 xterm 实例：${found}`);
        const r = await tab.evalJs(READERS[opts.reader].install);
        if (r !== 'ok') throw new Error(`装读取器失败：${r}`);
    };

    const focusTerminal = async () => {
        // 点终端中心：让输入焦点落到当前路径**自己的**输入元素上（xterm 的 helper
        // textarea 或我们的 overlay），不假设是哪一个。
        const box = await tab.evalJson(`(()=>{const e=document.querySelector('.xterm-screen')||document.querySelector('.xterm');
            if(!e) return 'null'; const r=e.getBoundingClientRect();
            return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2});})()`);
        if (!box || box === 'null') throw new Error('终端还没渲染出来（.xterm 不存在）');
        await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(250);
    };

    /** 焦点归属 + 有没有浮层 + 当前路由（用例前后各取一次，用来发现"键被 app 层吃掉"）。 */
    const focusState = async () => tab.evalJson(`JSON.stringify((()=>{
        const ae = document.activeElement;
        const ta = document.querySelector('.xterm-helper-textarea');
        const own = document.querySelector('.vh-term-input');
        const onTerminal = !!(ae && (ae === ta || ae === own || (own && own.contains(ae))));
        return {
          onTerminal,
          activeTag: ae ? (ae.tagName + (ae.className ? '.' + String(ae.className).slice(0,30) : '')) : null,
          overlay: !!document.querySelector('.vh-modal-layer, [role="dialog"][data-state="open"]'),
          route: location.pathname + location.search,
        };
    })())`);

    /** 关掉可能被打开的浮层（Esc）再把焦点点回终端。Esc 落进 raw 模式水槽是无害字节。 */
    const recoverFocus = async () => {
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
        await sleep(300);
        await focusTerminal();
    };

    const rawSendKey = async (kase) => {
        const modifiers = modBits(kase.mods ?? []);
        const common = {
            modifiers,
            windowsVirtualKeyCode: kase.keyCode,
            nativeVirtualKeyCode: kase.keyCode,   // T1：down/up 用同一份 keyCode，绝不错配
            key: kase.key,
            code: kase.code,
            location: 0,
        };
        const withText = opts.text && kase.text ? { text: kase.text, unmodifiedText: kase.text } : {};
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...withText });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });   // T1
    };

    const readDelta = async (before) => {
        const after = await tab.evalJson(`JSON.stringify(window.__VHGD.read())`);
        // 正常路径：clear() 成功 ⇒ before 是空数组，after 就是本次增量。
        // clear() 不成功（比如 emitted 被换成只读结构）时退回前缀比对；
        // 环形缓冲绕圈会让前缀对不上，那时只能取整段并标记（单键增量 ≤2 条，实际不会绕）。
        const raw = before.length === 0
            ? after
            : ((after.length >= before.length && before.every((v, i) => v === after[i])) ? after.slice(before.length) : after);
        const kept = raw.filter((s) => {
            if (!isTerminalAutoReply(s)) return true;
            noiseDropped++;
            return false;
        });
        return kept;
    };

    return {
        async preparePath(path) {
            if (tab) { await closeTab(port, tabId, tab); tab = null; }
            // T3/T4：一条路径 = 一个新 tab。绝不 reload，也不在终端页原地 navigate。
            const url = `${termUrl}&input=${path}`;
            tab = await openTab(port, url);
            tabId = tab.target.id;
            await waitFor(async () => (await tab.evalJs(`!!document.querySelector('.xterm')`)) === true,
                40000, `终端页没加载出来（${url}）`);
            await sleep(2500);   // 等 attach + 首屏
            await installProbe();
            await focusTerminal();

            const fingerprint = await tab.evalJson(FINGERPRINT);

            // T2：先发探针键断言通道活着 —— 否则得到的是"两边都没收到 ⇒ 全部一致"的假绿。
            await this.assertChannelAlive(path);

            return { fingerprint };
        },

        async assertChannelAlive(path) {
            const probe = { id: '__probe', group: 'probe', key: 'a', code: 'KeyA', keyCode: 65, mods: [], text: 'a' };
            for (let attempt = 1; attempt <= 3; attempt++) {
                await tab.evalJs(`window.__VHGD.clear()`);
                await rawSendKey(probe);
                await sleep(Math.max(opts.settle, 250));
                const got = await tab.evalJson(`JSON.stringify(window.__VHGD.read())`);
                if (got.join('').length > 0) return true;
                await focusTerminal();
            }
            throw new Error(
                `通道死的：?input=${path} 下探针键 'a' 没有产生任何 emitted。\n` +
                `  典型原因：窗口失焦（T2，dispatchKeyEvent 被静默丢弃）、焦点不在输入元素上、\n` +
                `  或 debugMode 没开导致 __vhTermInput 是个空壳。\n` +
                `  这时候继续跑只会得到"全部一致"的假绿 —— 所以这里直接判定 inconclusive。`);
        },

        /**
         * DECCKM = DEC private mode 1。开 = 应用光标键（方向键发 ESC O A），关 = 普通（ESC [ A）。
         * 用 term.write 本地写，不经 PTY。
         *
         * ⚠️ 实测坑（2026-08-14 首次全量跑就撞上）：**远端的输出会把这个模式打回去**
         *   —— tmux/应用重绘里带着 `\x1b[?1l` 之类的状态恢复，只要扫描期间来一次快照
         *   重放，DECCKM=on 就悄悄变回 off。7 个键的短跑撞不到，71 个键的长跑必撞。
         *   所以模式不是"设一次管一段"，而是**每个键之前都确认、必要时重设**（下面
         *   ensureMode），并在按键之后复查；反复被打回就判这条用例不可信，而不是
         *   拿一个错模式下的字节冒充 golden。
         */
        async setCursorKeyMode(on) {
            desiredDeckm = on;
            deckmResets = 0;
            const res = await applyMode(on);
            if (res.mode !== 'unknown' && res.mode !== on) {
                throw new Error(`DECCKM 没切成 ${on}（xterm 读回 ${res.mode}）—— 扫描结果不可信。现场：${JSON.stringify(res.diag ?? null)}`);
            }
            await sleep(80);
            return res;
        },

        async sendKey(kase) {
            for (let attempt = 1; attempt <= 3; attempt++) {
                // 每个用例都从"焦点在终端输入元素上、没有浮层"这个干净起点出发。
                const pre = await focusState();
                if (!pre.onTerminal) await recoverFocus();

                const mode = await readMode();
                if (mode !== 'unknown' && mode !== desiredDeckm) { deckmResets++; await applyMode(desiredDeckm); }

                const cleared = await tab.evalJs(`window.__VHGD.clear()`);
                const before = cleared ? [] : await tab.evalJson(`JSON.stringify(window.__VHGD.read())`);
                await rawSendKey(kase);
                await sleep(opts.settle);
                const afterMode = await readMode();
                const post = await focusState();
                const delta = await readDelta(before);

                if (post.route !== pre.route) {
                    throw new Error(`用例 ${kase.id} 把页面导航走了（${pre.route} → ${post.route}）—— ` +
                        `app 层有个快捷键吃掉了它。扫描已不在同一个屏幕上，判 inconclusive；` +
                        `用 --filter 绕开这个键，或先修 app 层的匹配器。`);
                }
                // ⚠️ 这是实测出来的第二个大坑（2026-08-14 全量跑）：Ctrl+j / Ctrl+k 会被
                //   app 的 window-capture 快捷键（notes dock ⌘J / 命令面板 ⌘K 的匹配器
                //   连 ctrlKey 一起认）吃掉 → 浮层弹出、焦点被夺走 → **之后每一个键都
                //   打进空气**，报告上表现为"53 个用例两边都是空串"的假一致。
                //   所以这里必须当场发现、当场恢复，并把这条用例标成"被 app 层消费"，
                //   而不是让它污染后面所有用例。
                const appConsumed = !post.onTerminal || post.overlay;
                if (appConsumed) await recoverFocus();

                if (afterMode === 'unknown' || afterMode === desiredDeckm) {
                    return { emitted: delta, appConsumed };
                }
                deckmResets++;
            }
            throw new Error(`DECCKM 在用例 ${kase.id} 上被远端反复重置，取不到可信样本 —— ` +
                `换个安静的终端再跑（或先 --no-prep 确认远端没在刷屏）`);
        },

        get deckmResets() { return deckmResets; },
        get noiseDropped() { return noiseDropped; },

        async dispose() {
            if (tab) { await closeTab(port, tabId, tab); tab = null; }
        },
    };
}

export async function waitFor(fn, timeoutMs, message) {
    const t0 = Date.now();
    for (;;) {
        let ok = false;
        try { ok = await fn(); } catch { ok = false; }
        if (ok) return true;
        if (Date.now() - t0 > timeoutMs) throw new Error(`超时：${message}`);
        await sleep(500);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 登录 / 建终端 / 清理
// ═══════════════════════════════════════════════════════════════════════════

export async function ensureLoggedIn(tab, opts) {
    await tab.send('Page.navigate', { url: `${opts.base}/` });
    await sleep(4000);
    const path = await tab.evalJs('location.pathname');
    if (!/login|welcome|restore/.test(path)) return 'already';
    const user = process.env.VH_USER, pass = process.env.VH_PASS;
    if (!user || !pass) {
        throw new Error(`profile 里没有登录态，且没给 VH_USER/VH_PASS（当前落在 ${path}）。\n` +
            `  第一次跑请： VH_USER=... VH_PASS=... node scripts/probe/term-input-goldendiff.mjs\n` +
            `  （profile ${opts.profile} 会记住登录态，之后不用再给）`);
    }
    const typeInto = async (sel, text) => {
        const box = await tab.evalJson(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});
            if(!e) return 'null'; const r=e.getBoundingClientRect();
            return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`);
        if (!box || box === 'null') throw new Error(`登录表单里找不到 ${sel}`);
        await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
        await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(200);
        // insertText 走真实 beforeinput/input，React 才看得见（直接设 value 不行）。
        await tab.send('Input.insertText', { text });
        await sleep(150);
    };
    await typeInto('input[autocomplete="username"], input[name="username"]', user);
    await typeInto('input[type="password"]', pass);
    await tab.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/继续|Continue|登录|Sign in/i.test(b.textContent||''));b&&b.click();return !!b})()`);
    await sleep(7000);
    const after = await tab.evalJs('location.pathname');
    if (/login/.test(after)) throw new Error('登录没成功（还在 /login）');
    return 'logged-in';
}

/** __vhTermInput 只在 debugMode 下挂。这个 profile 是本工具专用的独立"设备"，翻它无副作用。 */
export async function ensureDebugMode(tab) {
    const changed = await tab.evalJs(`(()=>{
      const K='mmkv:default:local-settings';
      let s = {}; try { s = JSON.parse(localStorage.getItem(K) || '{}') || {}; } catch (e) { s = {}; }
      if (s.debugMode === true) return 'already';
      s.debugMode = true;
      localStorage.setItem(K, JSON.stringify(s));
      return 'set';
    })()`);
    return changed;
}

function tmuxSessions() {
    const r = spawnSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('vh-'));
}

/**
 * 建一个**专用测试终端**。
 *
 * ⚠️⚠️ 这一段是用一次事故换来的，改之前先读完：
 *   /terminal 选择器上有**两组**行：上面一组是「机器」（点了 = 新建终端，navigate 带
 *   `fresh=1`），下面一组是「已打开的终端」（点了 = 打开一个**别人正在用的**终端，
 *   没有 fresh）。而终端行的 detail 正是机器名 ⇒ 用机器名去 match 会同时命中两组。
 *   2026-08-14 首次冒烟就是这么把一个从 8-12 活到现在的真终端当成"我新建的"给
 *   kill + 写墓碑了（ime-diag 的 04-create-term.mjs 取 `cands[cands.length-1]`，
 *   恰好取到最后一个 = 终端行，同一个坑）。
 *
 * 三道闸，缺一不可：
 *   ①  取**第一个**命中（机器组渲染在终端组之前），不是最后一个；
 *   ②  钩住 history.pushState/replaceState 抓下**跳转发生那一刻**的原始 URL，硬断言
 *       它带 `fresh=1`（WebTerminalScreen 消费完会把 fresh 从 URL 上抹掉，所以事后
 *       读 location.search 是读不到的 —— 必须在跳转瞬间抓）；没有 fresh=1 ⇒ 说明点到
 *       的是已存在的终端，**立刻中止，什么都不碰**；
 *   ③  断言 `vh-<tid>` 不在点击**之前**的 tmux 会话集合里（本机才有效）。
 * 清理时还会再查一次 ②③ 的 before 集合（见 cleanupTerminal 的调用点）。
 */
export async function createTestTerminal(tab, opts) {
    const before = new Set(tmuxSessions());
    await tab.send('Page.navigate', { url: `${opts.base}/terminal` });
    await sleep(4000);

    // 闸②的取证装置：在点击之前挂上，记录每一次路由跳转的原始 URL。
    await tab.evalJs(`(()=>{
      window.__VHGD_NAV = [];
      for (const m of ['pushState','replaceState']) {
        if (history['__vhgd_' + m]) continue;
        const orig = history[m].bind(history);
        history['__vhgd_' + m] = orig;
        history[m] = (a, b, url) => { try { window.__VHGD_NAV.push(String(url)); } catch (e) {} return orig(a, b, url); };
      }
      return 'ok';
    })()`);

    const clicked = await tab.evalJs(`(()=>{
      const main = document.querySelector('main') || document.body;
      const cands = [...main.querySelectorAll('button,[role="button"],a')]
        .filter(e => new RegExp(${JSON.stringify(opts.machine)}).test(e.textContent||''));
      if (!cands.length) return 'none';
      cands[0].click();          // 闸①：机器组在前，取第一个
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new Error(`/terminal 选择器里找不到机器 "${opts.machine}"（--machine 指定别的名字？）`);

    // 闸②：跳转那一刻的 URL 必须带 fresh=1
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) {
        await sleep(150);
        const navs = await tab.evalJson(`JSON.stringify(window.__VHGD_NAV || [])`);
        hit = navs.map((u) => /\/terminal\/([^/?]+)\?(.*)$/.exec(u))
            .filter(Boolean)
            .map((m) => ({ machineId: m[1], q: new URLSearchParams(m[2]) }))
            .find((x) => x.q.get('fresh') === '1' && x.q.get('tid'));
    }
    if (!hit) {
        const navs = await tab.evalJson(`JSON.stringify(window.__VHGD_NAV || [])`);
        throw new Error(
            `点下去没有产生一次 fresh=1 的新建跳转 —— 极可能点到了「已打开的终端」那一组，\n` +
            `  也就是别人正在用的终端。为避免重演 2026-08-14 那次误杀，这里直接中止，什么都不碰。\n` +
            `  抓到的跳转：${JSON.stringify(navs)}`);
    }
    const { machineId } = hit;
    const tid = hit.q.get('tid');

    // 闸③：新建出来的 id 绝不可能在点击之前就存在
    if (before.has(`vh-${tid}`)) {
        throw new Error(`断言失败：vh-${tid} 在点击之前就已存在 —— 这不是新建的终端，中止。`);
    }
    return { machineId, tid, discoveredBy: 'fresh-nav', before };
}

/**
 * 把终端压成字节水槽：raw 模式后 Ctrl+C/D/Z/S 都只是普通字节，扫描表里的危险键
 * 既杀不掉 shell 也执行不了东西。走 term.paste（= xterm 既有粘贴通路 → onData → sendInput）。
 */
export async function prepSink(tab) {
    const cmd = 'stty raw -echo -isig -ixon 2>/dev/null; cat > /dev/null\r';
    await tab.evalJs(`(()=>{const T=window.__VHGD_T; if(!T) return 'no term'; T.paste(${JSON.stringify(cmd)}); return 'ok';})()`);
    await sleep(1200);
}

const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清理：kill tmux 会话 + 写墓碑。**硬要求**（Owner 被"测试终端复活"坑过）。
 * ⚠️ 已知边界：daemon 自己也持有一份内存里的墓碑表，它下一次 kill 时会用自己的表
 *   整体覆盖这个文件 —— 那种情况下我们这条会被覆盖掉。墓碑本来就是"防陈旧客户端
 *   复活"的第二道闸，第一道闸（tmux 会话已经不存在）永远成立，所以可以接受；
 *   写成 read-modify-write + 原子 rename，至少不会踩掉别人的条目。
 */
export function cleanupTerminal(tid, { log = console.error, preExisting = null } = {}) {
    if (!tid) return { killed: false, tombstoned: false };
    // 最后一道保险：只杀"本次跑起来之前不存在"的会话。preExisting 是开跑前的 tmux
    // 快照；2026-08-14 的误杀就是死在没有这一条上。
    if (preExisting && preExisting.has(`vh-${tid}`)) {
        log(`⛔ 拒绝清理 vh-${tid}：它在本次开跑之前就存在，不是我们建的。请人工确认。`);
        return { killed: false, tombstoned: false, refused: true };
    }
    const kill = spawnSync('tmux', ['kill-session', '-t', `vh-${tid}`], { encoding: 'utf8' });
    const killed = kill.status === 0;
    let tombstoned = false;
    try {
        const file = join(homedir(), '.happy', 'terminal-tombstones.json');
        let map = {};
        try { map = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { map = {}; }
        const now = Date.now();
        const out = {};
        for (const [k, v] of Object.entries(map)) if (typeof v === 'number' && now - v < TOMBSTONE_TTL_MS) out[k] = v;
        out[tid] = now;
        mkdirSync(join(homedir(), '.happy'), { recursive: true });
        const tmp = `${file}.goldendiff.tmp`;
        writeFileSync(tmp, JSON.stringify(out));
        renameSync(tmp, file);
        tombstoned = true;
    } catch (e) {
        log(`⚠️ 写墓碑失败：${e.message}`);
    }
    log(`清理测试终端 vh-${tid}：tmux kill=${killed ? 'ok' : '（会话已不在）'} 墓碑=${tombstoned ? 'ok' : 'failed'}`);
    return { killed, tombstoned };
}

// ═══════════════════════════════════════════════════════════════════════════
// 离线自测（不开浏览器、不碰终端）：把"注入的读取器"跑通，验证表/差分/退出码
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个够用的 VT 参考编码器 —— **只服务于自测**。
 * 它不是 xterm 的权威复刻，也不该被当成 golden 期望值：真跑时两条路径的期望值
 * 来自对方，不来自这个表。它存在的唯一意义是让假会话吐出"形状真实"的字节。
 */
function refEncode(kase, deckm) {
    const mods = kase.mods ?? [];
    const has = (m) => mods.includes(m);
    const mbit = 1 + (has('Shift') ? 1 : 0) + (has('Alt') ? 2 : 0) + (has('Ctrl') ? 4 : 0);
    const arrowFinal = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };
    if (arrowFinal[kase.key]) {
        const f = arrowFinal[kase.key];
        if (mbit > 1) return `\x1b[1;${mbit}${f}`;
        return deckm ? `\x1bO${f}` : `\x1b[${f}`;
    }
    if (/^F\d+$/.test(kase.key)) {
        const n = Number(kase.key.slice(1));
        const f1to4 = { 1: 'P', 2: 'Q', 3: 'R', 4: 'S' };
        if (f1to4[n]) return `\x1bO${f1to4[n]}`;
        const tilde = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 }[n];
        return `\x1b[${tilde}~`;
    }
    switch (kase.key) {
        case 'Home': return deckm ? '\x1bOH' : '\x1b[H';
        case 'End': return deckm ? '\x1bOF' : '\x1b[F';
        case 'PageUp': return '\x1b[5~';
        case 'PageDown': return '\x1b[6~';
        case 'Insert': return '\x1b[2~';
        case 'Delete': return '\x1b[3~';
        case 'Backspace': return '\x7f';
        case 'Tab': return has('Shift') ? '\x1b[Z' : '\t';
        case 'Enter': return '\r';
        case 'Escape': return '\x1b';
        default: break;
    }
    if (has('Ctrl')) {
        const k = kase.keyCode;
        if (k >= 65 && k <= 90) return String.fromCharCode(k - 64);
        if (k === 32) return '\x00';
        if (k === 219) return '\x1b';
        if (k === 220) return '\x1c';
        if (k === 221) return '\x1d';
        if (k === 54) return '\x1e';
        if (k === 189) return '\x1f';
    }
    return '';
}

/** 假会话：两条路径的字节都由 refEncode 产出；faults 给 own 路径注入伤。 */
function createFakeSession({ faults = new Map() } = {}) {
    let path = null, deckm = false;
    return {
        async preparePath(p) { path = p; return { fingerprint: { fake: true, path, ownInputEls: p === 'own' ? 1 : 0 } }; },
        async setCursorKeyMode(on) { deckm = on; return { ok: true, mode: on }; },
        async sendKey(kase) {
            const base = refEncode(kase, deckm);
            if (path === 'own') {
                const f = faults.get(caseKey(deckm, kase.id)) ?? faults.get(kase.id);
                if (f !== undefined) return f === '' ? [] : [f];
            }
            return base === '' ? [] : [base];
        },
    };
}

async function selftest() {
    const table = buildScanTable();
    const problems = [];
    const check = (cond, msg) => { if (!cond) problems.push(msg); };

    // 1) 扫描表覆盖：spec §可测试性 点名的每一组都在，总数 ≈60（实际 71）
    const byGroup = table.reduce((a, k) => (a[k.group] = (a[k.group] ?? 0) + 1, a), {});
    check(byGroup.function === 12, `F1-F12 应为 12 项，实为 ${byGroup.function}`);
    check(byGroup.arrow === 16, `方向键×4 修饰 应为 16 项，实为 ${byGroup.arrow}`);
    check(byGroup.nav === 7, `Home/End/PgUp/PgDn/Insert/Delete/Backspace 应为 7 项，实为 ${byGroup.nav}`);
    check(byGroup['ctrl-letter'] === 26, `Ctrl+a..z 应为 26 项，实为 ${byGroup['ctrl-letter']}`);
    check(byGroup['ctrl-punct'] === 6, `Ctrl+[ ] \\ ^ _ Space 应为 6 项，实为 ${byGroup['ctrl-punct']}`);
    check(byGroup.tab === 2 && byGroup.control === 2, 'Tab/Shift+Tab 与 Enter/Escape 各应 2 项');
    check(new Set(table.map((k) => k.id)).size === table.length, '扫描表里有重复 id');
    check(table.every((k) => Number.isInteger(k.keyCode) && k.keyCode > 0), '有用例缺 keyCode（down/up 配不上，T1）');

    // 2) 两条路径完全一致 ⇒ 零差异，exit 0
    const clean = await runScan({ session: createFakeSession(), table });
    const d1 = diffResults({ results: clean.results, table });
    check(d1.total === table.length * 2, `用例数应为 ${table.length * 2}，实为 ${d1.total}`);
    check(d1.mismatches.length === 0, `干净跑应零差异，实为 ${d1.mismatches.length}`);
    check(exitCodeFor(d1) === 0, '干净跑退出码应为 0');

    // 3) 注入伤 ⇒ 恰好报出被注入的那几条，exit 1
    //    伤情覆盖三种真实病象：R3 的"Ctrl+方向落进 P7 什么都没发"、"Tab 忘 preventDefault
    //    ⇒ 变成一个制表符"、以及 DECCKM 只在某一态下编错。
    const faults = new Map([
        ['Ctrl+ArrowLeft', ''],
        ['Tab', '\t\t'],
        [caseKey(true, 'ArrowUp'), '\x1b[A'],   // DECCKM=on 却发了普通序列
    ]);
    const hurt = await runScan({ session: createFakeSession({ faults }), table });
    const d2 = diffResults({ results: hurt.results, table });
    const got = new Set(d2.mismatches.map((m) => m.key));
    const want = new Set([
        caseKey(false, 'Ctrl+ArrowLeft'), caseKey(true, 'Ctrl+ArrowLeft'),
        caseKey(false, 'Tab'), caseKey(true, 'Tab'),
        caseKey(true, 'ArrowUp'),
    ]);
    check(got.size === want.size && [...want].every((w) => got.has(w)),
        `注入伤应恰好报出 ${[...want].join(', ')}，实为 ${[...got].join(', ')}`);
    check(exitCodeFor(d2) === 1, '有差异时退出码应为 1');

    // 4) 报告渲染不炸，且差异行里能看见转义后的字节
    const text = renderReport(d2, {
        base: '(selftest)', machine: '(none)', terminalId: null, paths: ['xterm', 'own'],
        readerLabel: '注入的假读取器', tableSize: table.length, deckmStates: [false, true],
        fingerprints: hurt.fingerprints,
    }, { verbose: false });
    check(/Ctrl\+ArrowLeft/.test(text) && /\(空\)/.test(text), '报告里应能看到 Ctrl+ArrowLeft 与 (空)');
    check(/ESC\[1;5D/.test(text), '报告里应能看到转义后的 ESC[1;5D');

    // 4.5) 噪声过滤器：终端自动回复要丢掉，真按键字节一条都不能丢
    check(isTerminalAutoReply('\x1b]10;rgb:e8e8/eded/f4f4\x1b\\\x1b]11;rgb:0606/0808/0c0c\x1b\\'),
        'OSC 10/11 颜色回报应被认成自动回复（实测混进过采样）');
    check(isTerminalAutoReply('\x1b[?62;c') && isTerminalAutoReply('\x1b[24;80R') && isTerminalAutoReply('\x1b[I'),
        'DA / DSR / 焦点上报应被认成自动回复');
    for (const s of ['\x1b[A', '\x1bOA', '\x1b[1;5D', '\r', '\t', '\x1b', '\x7f', '\x01', '\x1b[15~'])
        check(!isTerminalAutoReply(s), `真按键字节 ${JSON.stringify(s)} 绝不能被当噪声丢掉`);

    // 5) 指纹分叉断言：两条路径指纹相同必须能被识别（反假绿）
    check(JSON.stringify(hurt.fingerprints.xterm) !== JSON.stringify(hurt.fingerprints.own),
        '假会话的两条路径指纹应当不同（否则分叉断言测不到）');

    console.log(text);
    console.log('');
    if (problems.length) {
        console.log('自测 FAILED：');
        for (const p of problems) console.log(`  ✘ ${p}`);
        return 2;
    }
    console.log(`自测 PASSED：扫描表 ${table.length} 项 / ${table.length * 2} 用例；` +
        `干净跑 0 差异 exit 0；注入 3 处伤恰好报出 ${d2.mismatches.length} 条 exit 1。`);
    return 0;
}

const exitCodeFor = (diff) => (diff.mismatches.length === 0 ? 0 : 1);

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); return 2; }
    if (opts.help) { console.log(HELP); return 0; }
    if (opts.selftest) return selftest();
    if (!READERS[opts.reader]) { console.error(`--reader 只能是 ${Object.keys(READERS).join('/')}`); return 2; }

    mkdirSync(opts.outDir, { recursive: true });
    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const pendingFile = join(opts.outDir, 'pending-cleanup.json');
    const table = buildScanTable().filter((k) => !opts.filter || opts.filter.test(k.id));
    const paths = ['xterm', 'own'];
    const deckmStates = [false, true];

    let terminalId = opts.reuseTerminal ?? null;
    let ownsTerminal = false;
    let preExisting = null;      // 开跑前的 tmux 会话快照，清理时的最后一道保险
    let session = null;
    let setupTab = null;
    let exitCode = 2;
    let report = null;

    const doCleanup = () => {
        if (!ownsTerminal || !terminalId) return;
        if (opts.keepTerminal) {
            console.error(`⚠️ --keep-terminal：测试终端 vh-${terminalId} 留着没清 —— 记得手工 tmux kill-session -t vh-${terminalId}`);
            return;
        }
        cleanupTerminal(terminalId, { preExisting });
        try { if (existsSync(pendingFile)) unlinkSync(pendingFile); } catch { /* 无所谓 */ }
        ownsTerminal = false;
    };
    // Ctrl-C 也要清（否则就是一个活着的测试终端 + 一个被坑的 Owner）。
    const onSignal = () => { doCleanup(); process.exit(130); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        const chrome = await ensureChrome(opts);
        console.error(`Chrome ${chrome.version}（${chrome.launched ? '本次拉起' : '复用已在跑的'}，port ${opts.port}，profile ${opts.profile}）`);

        setupTab = await attachExisting(opts.port, 'about:blank');
        console.error(`登录状态：${await ensureLoggedIn(setupTab, opts)}`);
        console.error(`debugMode：${await ensureDebugMode(setupTab)}`);

        let machineId = null;
        if (terminalId) {
            // 复用现成终端：需要 machineId 才能拼 URL，从当前页面/URL 推。
            await setupTab.send('Page.navigate', { url: `${opts.base}/terminal` });
            await sleep(3000);
            machineId = await setupTab.evalJs(`(()=>{const a=[...document.querySelectorAll('a[href*="/terminal/"]')]
                .map(a=>a.getAttribute('href')); const m=a.map(h=>/\\/terminal\\/([^/?]+)/.exec(h)).find(Boolean); return m?m[1]:null;})()`);
            if (!machineId) throw new Error('--reuse-terminal 需要能从页面推出 machineId，没推出来');
            console.error(`复用终端 vh-${terminalId}（不新建、不清理）`);
        } else {
            const created = await createTestTerminal(setupTab, opts);
            machineId = created.machineId;
            terminalId = created.tid;
            preExisting = created.before;
            ownsTerminal = true;
            writeFileSync(pendingFile, JSON.stringify({ terminalId, machineId, at: Date.now(), pid: process.pid }, null, 2));
            console.error(`专用测试终端 vh-${terminalId}（machine ${machineId}，来源 ${created.discoveredBy}）—— 跑完会 kill + 写墓碑`);
            await waitFor(async () => (await setupTab.evalJs(`!!document.querySelector('.xterm')`)) === true, 40000, '新终端没连上');
            await sleep(2500);
            if (opts.prep) {
                const found = await setupTab.evalJs(FIND_TERM);
                if (found !== 'ok') throw new Error(`建终端后找不到 xterm 实例：${found}`);
                await prepSink(setupTab);
                console.error('已把终端压成 raw 模式字节水槽（Ctrl+C/D/Z/S 只是字节，不会杀 shell）');
            } else {
                console.error('⚠️ --no-prep：终端是普通交互 shell，扫描表里的 Ctrl+D/Enter 会真的作用到 shell 上');
            }
        }
        // 建/复用用的这个 tab 用完就关：一条路径 = 一个新 tab（T3），别让旧 tab 也连着终端。
        await closeTab(opts.port, setupTab.target.id, setupTab);
        setupTab = null;

        const termUrl = `${opts.base}/terminal/${machineId}?tid=${terminalId}`;
        session = createBrowserSession({ opts, port: opts.port, termUrl });

        console.error(`开跑：${table.length} 项 × DECCKM off/on × ${paths.join('/')} = ${table.length * 2 * paths.length} 次按键`);
        const t0 = Date.now();
        const { results, fingerprints } = await runScan({
            session, table, paths, deckmStates,
            onProgress: ({ path, deckm, kase, joined }) => {
                if (opts.verbose) console.error(`  [${path}/${deckm ? 'on' : 'off'}] ${kase.id} → ${esc(joined)}`);
            },
        });
        console.error(`扫描完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

        // 反假绿：两条路径的**行为**指纹必须不同（URL 不算），否则 `?input=` 压根没生效，
        // "逐字节一致"只是"同一条路径跑了两遍"。
        const beh = (p) => JSON.stringify(fingerprints[p]?.behavior ?? fingerprints[p] ?? null);
        const fpSame = beh(paths[0]) === beh(paths[1]);
        // 正面断言（只告警不拦）：own 路径按 spec 应该恰好有 1 个 .vh-term-input，
        // xterm 路径应该 0 个；不符说明契约的 DOM 形状和 spec 对不上，值得看一眼。
        const ownEls = fingerprints.own?.behavior?.ownInputEls;
        const xtermEls = fingerprints.xterm?.behavior?.ownInputEls;
        if (!fpSame && (ownEls !== 1 || xtermEls !== 0)) {
            console.error(`⚠️ 结构与 spec 不符：.vh-term-input 个数 own=${ownEls} xterm=${xtermEls}（期望 1 / 0）`);
        }
        if (fpSame && !opts.allowSamePath) {
            throw new Error(
                `两条路径的页面指纹完全相同 —— "?input=" 覆盖没生效（Step 1 契约没上线？）。\n` +
                `  指纹：${JSON.stringify(fingerprints[paths[0]])}\n` +
                `  这时的"全部一致"是同一条路径跑了两遍，不构成任何护栏 ⇒ 判 inconclusive。\n` +
                `  确实想看结果就加 --allow-same-path。`);
        }

        const diff = diffResults({ results, table, deckmStates, paths });
        const meta = {
            base: opts.base, machine: opts.machine, terminalId, machineId, paths,
            reader: opts.reader, readerLabel: READERS[opts.reader].label,
            tableSize: table.length, deckmStates, fingerprints,
            startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
            chrome: chrome.version, settleMs: opts.settle, prep: opts.prep, textOnEnterTab: opts.text,
            deckmResets: session.deckmResets ?? 0,
            noiseDropped: session.noiseDropped ?? 0,
        };
        if (meta.deckmResets > 0) {
            console.error(`（DECCKM 被远端输出打回 ${meta.deckmResets} 次，已在每个用例前自动重设）`);
        }
        if (meta.noiseDropped > 0) {
            console.error(`（丢掉 ${meta.noiseDropped} 条终端自动回复：OSC 颜色回报 / DA / DSR / 焦点上报，不是按键产物）`);
        }
        report = { meta, summary: { total: diff.total, mismatches: diff.mismatches.length, bothEmpty: diff.bothEmpty.length }, rows: diff.rows };
        console.log(renderReport(diff, meta, { verbose: opts.verbose }));
        exitCode = exitCodeFor(diff);
        if (opts.reader === 'ondata') {
            console.log('');
            console.log('⚠️ 用的是 ondata 兜底读取器：它只看得见走 xterm 编码器的字节，own 路径直接');
            console.log('   sendInput 的那条腿它看不见 ⇒ 本次结果不能当 Step 3 的门，只能当工具冒烟。');
        }
    } catch (e) {
        console.error('');
        console.error(`✘ 跑不出结论：${e.message}`);
        if (opts.verbose && e.stack) console.error(e.stack);
        exitCode = 2;
        report = report ?? { meta: { base: opts.base, terminalId, error: e.message, at: new Date().toISOString() }, rows: [] };
    } finally {
        try { await session?.dispose(); } catch { /* tab 已关 */ }
        try { if (setupTab) await closeTab(opts.port, setupTab.target.id, setupTab); } catch { /* 同上 */ }
        // 硬要求：无论成功失败，专用测试终端都要清干净。
        doCleanup();
        if (report) {
            const out = join(opts.outDir, `golden-${stamp}.json`);
            writeFileSync(out, JSON.stringify(report, null, 2));
            console.error(`原始结果：${out}`);
        }
    }
    return exitCode;
}

// 直接执行才跑 main —— 上面那些纯函数（扫描表 / 差分 / 噪声过滤）要能被别的脚本
// import 来复用或单测，import 一下就把整个扫描跑起来是不可接受的。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
