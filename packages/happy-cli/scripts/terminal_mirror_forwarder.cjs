#!/usr/bin/env node
/**
 * Terminal Mirror Hook Forwarder (B-105)
 *
 * Installed GLOBALLY into the user's ~/.claude/settings.json by
 * `happy install-terminal-hooks` (SessionStart + SessionEnd, as a pair).
 * Executed by claude for EVERY session on the machine — so the first two
 * checks make it exit silently for everything that is not a hand-typed
 * claude inside a vh web terminal:
 *
 *   1. HAPPY_MANAGED is set    → this claude is run BY happy (local or SDK
 *      path); its session already flows through happy's own pipeline —
 *      forwarding would double-upload (spec M-2, deterministic main guard).
 *   2. VH_TERMINAL_ID is unset → not inside a vh web terminal (the daemon
 *      injects it via `tmux new-session -e` at terminal creation).
 *
 * Otherwise it reads the daemon's control port from daemon.state.json —
 * located via VH_HAPPY_HOME_DIR (also injected at terminal creation, so a
 * dev-variant terminal reports to the dev daemon, spec risk 7) — appends the
 * terminalId to claude's hook JSON from stdin, and POSTs it to
 * /terminal-hook. All failures are silent: a hook must never break claude.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.HAPPY_MANAGED) process.exit(0);
const terminalId = process.env.VH_TERMINAL_ID;
if (!terminalId) process.exit(0);

const happyHome = process.env.VH_HAPPY_HOME_DIR
    || process.env.HAPPY_HOME_DIR
    || path.join(os.homedir(), '.happy');

let port = null;
let controlToken = null;
try {
    const state = JSON.parse(fs.readFileSync(path.join(happyHome, 'daemon.state.json'), 'utf-8'));
    if (state && typeof state.httpPort === 'number') port = state.httpPort;
    if (state && typeof state.controlToken === 'string') controlToken = state.controlToken;
} catch {
    // no daemon → nothing to mirror to
}
if (!port) process.exit(0);

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
    let payload = {};
    try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
        // still forward the envelope — the daemon-side parser will drop it
    }
    if (!payload || typeof payload !== 'object') payload = {};
    payload.terminalId = terminalId;
    const body = Buffer.from(JSON.stringify(payload));

    const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/terminal-hook',
        timeout: 5000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            ...(controlToken ? { Authorization: `Bearer ${controlToken}` } : {}),
        },
    }, (res) => { res.resume(); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { /* silent — never break claude */ });
    req.end(body);
});
process.stdin.resume();
