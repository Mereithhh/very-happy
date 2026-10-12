#!/usr/bin/env node
/**
 * Terminal Status Hook Forwarder (B-547)
 *
 * Wired ONLY through the per-terminal `--settings` file the daemon writes
 * when it types a `claude …` command into a vh web terminal (never into the
 * user's ~/.claude/settings.json). Usage, as built by terminalHookCommand():
 *
 *   node terminal_status_forwarder.cjs <terminalId> <happyHome> <claudePid>
 *
 * Reads claude's hook JSON from stdin, keeps a small whitelist of fields
 * (no prompt text, no tool input/output, no assistant text — the prompt is
 * reduced to a short hash used only as a turn identity), and POSTs it to the
 * daemon's /terminal-agent-hook with the control token from daemon.state.json.
 *
 * Contract with claude: write NOTHING to stdout (PermissionRequest /
 * UserPromptSubmit treat stdout as a decision / extra context) and always
 * exit 0. Every failure is silent.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [terminalId, happyHome, claudePid] = process.argv.slice(2);
if (!terminalId || !/^[A-Za-z0-9_-]{1,64}$/.test(terminalId) || !happyHome) process.exit(0);

let port = null;
let controlToken = null;
try {
    const state = JSON.parse(fs.readFileSync(path.join(happyHome, 'daemon.state.json'), 'utf-8'));
    if (state && typeof state.httpPort === 'number') port = state.httpPort;
    if (state && typeof state.controlToken === 'string') controlToken = state.controlToken;
} catch {
    // no daemon → nothing to report to
}

const FIELDS = [
    'hook_event_name', 'session_id', 'transcript_path', 'cwd', 'prompt_id', 'agent_id',
    'source', 'notification_type', 'trigger', 'reason', 'tool_name',
];

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
    if (!port) process.exit(0);
    let input = {};
    try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
        process.exit(0);
    }
    if (!input || typeof input !== 'object') process.exit(0);
    const payload = { terminalId };
    for (const key of FIELDS) {
        if (typeof input[key] === 'string' && input[key].length <= 4096) payload[key] = input[key];
    }
    if (claudePid && /^\d{1,10}$/.test(claudePid)) payload.claudePid = Number(claudePid);
    if (typeof input.prompt === 'string') {
        payload.promptHash = crypto.createHash('sha256').update(input.prompt).digest('hex').slice(0, 16);
    }
    // Older Claude Notification payloads carry no notification_type.
    if (input.hook_event_name === 'Notification' && typeof input.notification_type !== 'string'
        && typeof input.message === 'string' && /permission/i.test(input.message)) {
        payload.permissionHint = true;
    }
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/terminal-agent-hook',
        timeout: 2000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            ...(controlToken ? { Authorization: `Bearer ${controlToken}` } : {}),
        },
    }, (res) => {
        res.resume();
        res.on('end', () => process.exit(0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => process.exit(0));
    req.end(body);
});
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
