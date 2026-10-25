#!/usr/bin/env node
/**
 * sync-hello-canary —— B-811 / B-807 阶段 1：对真站只读地发 sync-hello，验 ack 与时延。
 *
 * 只读：GET /v2/sessions 取会话 id，然后在一条 user-scoped socket 上发 `sync-hello`
 * 和 `session-subscribe`/`session-unsubscribe`。不写消息、不改设置、不调 RPC。
 * 握手带 appState=background，不会让服务端以为用户在前台而吞掉推送通知。
 *
 * 用法：
 *   node scripts/probe/sync-hello-canary.mjs                          # 默认 veryhappy.dev，20 轮
 *   node scripts/probe/sync-hello-canary.mjs --rounds 60 --interval 1500
 *   node scripts/probe/sync-hello-canary.mjs --watch                  # 一直跑，蓝绿切流时用；Ctrl-C 出汇总
 *   node scripts/probe/sync-hello-canary.mjs --server http://127.0.0.1:3005 --token <t>
 *   node scripts/probe/sync-hello-canary.mjs --json                   # 机器可读汇总
 *
 * token：--token > $VH_TOKEN > --token-file（默认 ~/.happy/access.key 的 .token，即本机 CLI 的账号 token）。
 * token 只用于 Authorization 与 socket 握手，不打印。
 *
 * 判定（退出码）：
 *   0  每次 hello 都 ok:true，且客户端 ack RTT P95 ≤ --p95-ms（默认 300）
 *   1  有失败的 ack（error / 超时 / 不一致），或 P95 超阈值
 *   2  跑不出结论：鉴权失败、连不上
 *   3  服务端回 disabled（开关 SYNC_SUBSCRIBE_DISABLED=1，或账号不在 SYNC_SUBSCRIBE_ACCOUNTS）
 *   4  没有任何 ack（服务端还没有 handler：旧镜像）
 *
 * 服务端 snapshot 时延（阶段 1 门槛：cold、warm 各自 P95 < 30ms）看 Prometheus：
 *   histogram_quantile(0.95, sum by (le, shape) (rate(sync_snapshot_duration_seconds_bucket{op="hello"}[5m])))
 * 本脚本量的是客户端 RTT（含网络），两者一起看。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';

const ACK_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
    const opts = {
        server: 'https://veryhappy.dev',
        token: process.env.VH_TOKEN || null,
        tokenFile: join(homedir(), '.happy', 'access.key'),
        rounds: 20,
        interval: 1_500,
        sessions: 8,
        p95: 300,
        watch: false,
        json: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            const next = argv[i + 1];
            if (next === undefined) throw new Error(`${arg} needs a value`);
            i += 1;
            return next;
        };
        switch (arg) {
            case '--server': opts.server = value().replace(/\/$/, ''); break;
            case '--token': opts.token = value(); break;
            case '--token-file': opts.tokenFile = value(); break;
            case '--rounds': opts.rounds = Number(value()); break;
            case '--interval': opts.interval = Number(value()); break;
            case '--sessions': opts.sessions = Math.min(16, Number(value())); break;
            case '--p95-ms': opts.p95 = Number(value()); break;
            case '--watch': opts.watch = true; break;
            case '--json': opts.json = true; break;
            case '-h': case '--help':
                console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
                process.exit(0);
            default: throw new Error(`unknown option ${arg}`);
        }
    }
    return opts;
}

function loadToken(opts) {
    if (opts.token) return opts.token;
    const parsed = JSON.parse(readFileSync(opts.tokenFile, 'utf8'));
    if (typeof parsed.token !== 'string') throw new Error(`no .token in ${opts.tokenFile}`);
    return parsed.token;
}

const percentile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function listSessions(opts, token) {
    const response = await fetch(`${opts.server}/v2/sessions?limit=${opts.sessions}`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error(`auth rejected (${response.status})`), { exitCode: 2 });
    if (!response.ok) throw Object.assign(new Error(`GET /v2/sessions ${response.status}`), { exitCode: 2 });
    const body = await response.json();
    return body.sessions.map((session) => ({ sid: session.id, seq: session.seq }));
}

function connectSocket(opts, token) {
    return io(opts.server, {
        path: '/v1/updates',
        transports: ['websocket'],
        auth: { token, clientType: 'user-scoped', appState: 'background', happyClient: 'sync-hello-canary/1' },
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3_000,
    });
}

async function timedAck(socket, event, payload) {
    const startedAt = performance.now();
    try {
        const ack = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
        return { ack, ms: performance.now() - startedAt };
    } catch {
        return { ack: null, ms: performance.now() - startedAt };
    }
}

/** A sub result that contradicts its own snapshot (spec §4.2). */
function inconsistency(result, afterSeq) {
    if (!result?.ok) return null;
    const seqs = result.messages.map((m) => m.seq);
    if (seqs.some((seq, i) => i > 0 && seq <= seqs[i - 1])) return 'page not ascending';
    if (seqs.some((seq) => seq > result.headSeq)) return 'page beyond head';
    if (afterSeq !== null && !result.gapTooLarge && seqs.some((seq) => seq <= afterSeq)) return 'page not after afterSeq';
    return null;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const token = loadToken(opts);
    const sessions = await listSessions(opts, token);
    const heads = new Map(sessions.map((s) => [s.sid, s.seq]));

    const socket = connectSocket(opts, token);
    const stats = {
        server: opts.server,
        sessions: sessions.length,
        hello: { ok: 0, errors: {}, noAck: 0 },
        subscribe: { ok: 0, errors: {}, noAck: 0 },
        rttHello: [],
        rttSubscribe: [],
        inconsistencies: [],
        /** Cold page's newest seq ≠ headSeq: legacy seq holes (see B-811 PR notes). */
        headAboveNewest: 0,
        coldChecked: 0,
        connects: 0,
        disconnects: 0,
        serverTimeSkewMs: null,
    };
    socket.on('connect', () => { stats.connects += 1; });
    socket.on('disconnect', () => { stats.disconnects += 1; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('socket connect timed out'), { exitCode: 2 })), 15_000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.on('connect_error', (error) => {
            if (/authentication/i.test(error.message)) { clearTimeout(timer); reject(Object.assign(new Error(`socket auth: ${error.message}`), { exitCode: 2 })); }
        });
    });

    const count = (bucket, ack) => {
        if (!ack) bucket.noAck += 1;
        else if (ack.ok) bucket.ok += 1;
        else bucket.errors[ack.error] = (bucket.errors[ack.error] ?? 0) + 1;
    };

    let stopping = false;
    process.on('SIGINT', () => { stopping = true; });
    const say = (line) => { if (!opts.json) console.log(line); };

    for (let round = 0; !stopping && (opts.watch || round < opts.rounds); round += 1) {
        if (!socket.connected) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            round -= 1;
            continue;
        }
        const cold = round % 2 === 0;
        const subs = sessions.map(({ sid }) => ({ sid, afterSeq: cold ? null : heads.get(sid) ?? 0, limit: cold ? 1 : 50 }));
        const hello = await timedAck(socket, 'sync-hello', { v: 1, subs, reason: round === 0 ? 'connect' : 'retry' });
        count(stats.hello, hello.ack);
        if (hello.ack) stats.rttHello.push(hello.ms);
        if (hello.ack?.ok) {
            stats.serverTimeSkewMs = Math.round(hello.ack.serverTime - Date.now());
            hello.ack.results.forEach((result, i) => {
                const problem = inconsistency(result, subs[i].afterSeq);
                if (problem) stats.inconsistencies.push({ sid: result.sid, problem });
                if (!result.ok) return;
                if (cold) {
                    stats.coldChecked += 1;
                    const newest = result.messages.at(-1)?.seq ?? 0;
                    if (newest !== result.headSeq) stats.headAboveNewest += 1;
                }
                heads.set(result.sid, result.headSeq);
            });
        }

        const target = sessions[round % Math.max(1, sessions.length)];
        if (target) {
            const sub = await timedAck(socket, 'session-subscribe', { v: 1, sid: target.sid, afterSeq: heads.get(target.sid) ?? 0, limit: 50 });
            count(stats.subscribe, sub.ack);
            if (sub.ack) stats.rttSubscribe.push(sub.ms);
            const problem = inconsistency(sub.ack, heads.get(target.sid) ?? 0);
            if (problem) stats.inconsistencies.push({ sid: target.sid, problem });
            await timedAck(socket, 'session-unsubscribe', { v: 1, sid: target.sid });
        }

        const status = !hello.ack ? 'NO-ACK' : hello.ack.ok ? 'ok' : hello.ack.error;
        say(`[${new Date().toISOString()}] round ${round + 1} ${cold ? 'cold' : 'warm'} hello=${status} ${hello.ms.toFixed(0)}ms`);
        await new Promise((resolve) => setTimeout(resolve, opts.interval));
    }
    socket.close();

    const summary = {
        ...stats,
        rttHelloP50: percentile(stats.rttHello, 50),
        rttHelloP95: percentile(stats.rttHello, 95),
        rttSubscribeP95: percentile(stats.rttSubscribe, 95),
        rttHello: undefined,
        rttSubscribe: undefined,
    };
    const totalHello = stats.hello.ok + stats.hello.noAck + Object.values(stats.hello.errors).reduce((a, b) => a + b, 0);
    let exitCode = 0;
    if (stats.hello.ok === 0 && stats.hello.noAck === totalHello) exitCode = 4;
    else if (stats.hello.errors.disabled && stats.hello.ok === 0) exitCode = 3;
    else if (stats.hello.ok < totalHello || stats.subscribe.noAck > 0 || Object.keys(stats.subscribe.errors).length > 0
        || stats.inconsistencies.length > 0 || (summary.rttHelloP95 ?? Infinity) > opts.p95) exitCode = 1;
    summary.verdict = ['pass', 'fail', 'inconclusive', 'disabled', 'no-handler'][exitCode];

    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else {
        const fmt = (v) => v === null ? '-' : `${v.toFixed(0)}ms`;
        console.log('\n== sync-hello canary ==');
        console.log(`server ${summary.server}  sessions ${summary.sessions}  connects ${summary.connects}  disconnects ${summary.disconnects}`);
        console.log(`hello      ok ${stats.hello.ok}/${totalHello}  errors ${JSON.stringify(stats.hello.errors)}  no-ack ${stats.hello.noAck}  RTT p50 ${fmt(summary.rttHelloP50)} p95 ${fmt(summary.rttHelloP95)}`);
        console.log(`subscribe  ok ${stats.subscribe.ok}  errors ${JSON.stringify(stats.subscribe.errors)}  no-ack ${stats.subscribe.noAck}  RTT p95 ${fmt(summary.rttSubscribeP95)}`);
        console.log(`consistency issues ${stats.inconsistencies.length}  cold head≠newest seq ${stats.headAboveNewest}/${stats.coldChecked}  server clock skew ${stats.serverTimeSkewMs ?? '-'}ms`);
        console.log(`verdict ${summary.verdict} (exit ${exitCode})`);
    }
    process.exit(exitCode);
}

main().catch((error) => {
    console.error(`sync-hello-canary: ${error.message}`);
    process.exit(error.exitCode ?? 2);
});
