// Hello Board: a zero-dependency Very Happy plugin (vh-plugin/v1) that uses all
// four extension points. Run: node server.mjs   (Node 20+). See README.md.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDedupe, verifyEvent, verifyRequest } from './verify.mjs';

const PORT = Number(process.env.HELLO_PORT ?? 4310);
const SESSION_ID = process.env.HELLO_SESSION_ID || null;
const PULL = process.env.HELLO_PULL === '1';
const INSECURE_LOCAL = process.env.HELLO_INSECURE_LOCAL === '1';
const DIR = join(process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy'), 'plugins', 'hello-board');

// Credentials appear only after the owner approves the install; re-read on every call (rotate-safe).
const readText = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };
const apiBase = () => process.env.VH_PLUGIN_API ?? (() => { try { return JSON.parse(readFileSync(join(DIR, 'runtime.json'), 'utf8')).api; } catch { return null; } })();
const token = () => readText(process.env.VH_PLUGIN_TOKEN_FILE ?? join(DIR, 'token'));
const secret = () => readText(process.env.VH_PLUGIN_SECRET_FILE ?? join(DIR, 'secret'));

let count = 0;
let label = 'Hello';

async function vh(method, path, body) {
    const base = apiBase(), tok = token();
    if (!base || !tok) return { status: 0, body: { error: 'not_approved_yet' } };
    try {
        const res = await fetch(base + path, {
            method,
            headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        // 503 server_unreachable + queued:true means the daemon will replay it; nothing to do.
        if (!res.ok && !json.queued) console.warn(`[vh] ${method} ${path} → ${res.status} ${json.error ?? ''}`);
        return { status: res.status, body: json };
    } catch (e) {
        console.warn(`[vh] ${method} ${path} failed: ${e.message}`);
        return { status: 0, body: { error: 'daemon_unreachable' } };
    }
}

async function publish() {
    await vh('PUT', '/badge', { count: count || null, tone: count > 0 && count % 5 === 0 ? 'attention' : 'default', label: `${label}: ${count}`.slice(0, 16) });
    if (SESSION_ID) {
        await vh('PUT', `/sessions/${encodeURIComponent(SESSION_ID)}/widget`, {
            status: { label: `count: ${count}`, tone: count % 5 === 0 && count > 0 ? 'warning' : 'info' },
            text: `${label} counter is at ${count}.`,
            actions: [{ id: 'inc', label: '+1', style: 'primary' }, { id: 'reset', label: 'Reset', style: 'danger', confirm: 'Reset the counter to 0?' }],
            panelPath: '/',
        });
    }
    if (count > 0 && count % 5 === 0) {
        await vh('POST', '/decisions', {
            key: `count:${count}`, kind: 'choice', title: `${label} reached ${count}`,
            bodyMd: 'Keep counting, or reset the counter to **0**?',
            options: [{ id: 'continue', label: 'Continue', style: 'primary' }, { id: 'reset', label: 'Reset', style: 'danger' }],
            panelPath: '/',
        });
    }
}

function setCount(n) { count = Math.max(0, n); void publish(); }

// ─── Events (push callback or pull) ───────────────────────────────────────────

const firstTime = createDedupe();
async function handleEvent(event) {
    if (event.type === 'decision.responded') {
        const { key, action, choice, text } = event.data;
        if (key.startsWith('count:') && action === 'choose' && choice === 'reset') setCount(0);
        if (key === 'label' && action === 'submit' && text) { label = text.slice(0, 40); void publish(); }
        await vh('DELETE', `/decisions/${encodeURIComponent(key)}`, { outcome: 'done' });
    } else if (event.type === 'widget.action') {
        if (event.data.actionId === 'inc') setCount(count + 1);
        if (event.data.actionId === 'reset') setCount(0);
    } else if (event.type === 'install.changed') {
        console.log(`[vh] install is now ${event.data.state}; grants: ${event.data.grants.join(', ')}`);
        if (event.data.state === 'enabled') void publish();
    }
}

async function pullLoop() {
    let cursor = '';
    for (;;) {
        const r = await vh('GET', `/events?wait=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
        if (r.status !== 200) { await new Promise(f => setTimeout(f, 5000)); continue; }
        for (const { rawBody, timestamp, signature, event } of r.body.events) {
            const ok = verifyEvent({ secret: secret(), rawBody, headers: { 'x-vh-timestamp': String(timestamp), 'x-vh-event-id': event.id, 'x-vh-signature': signature } });
            if (ok && firstTime(event.id)) await handleEvent(event);
        }
        if (r.body.cursor && r.body.cursor !== cursor) { cursor = r.body.cursor; await vh('POST', '/events/ack', { upTo: cursor }); }
    }
}

// ─── HTTP: panel page, panel API, callback ────────────────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello Board</title><style>
body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#fafafa;color:#222}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}}
.n{font-size:64px;font-weight:700;margin:12px 0}button{font:inherit;padding:8px 16px;margin-right:8px;border-radius:8px;border:1px solid #888;background:none;color:inherit}
small{opacity:.7}</style></head><body>
<h1 id="label">Hello</h1><div class="n" id="n">…</div>
<button id="inc">+1</button><button id="reset">Reset</button><button id="ask">Ask me for a label</button>
<p><small id="seen"></small></p>
<script>
const $ = (id) => document.getElementById(id);
async function call(path, body) {   // absolute paths work: this page owns its own origin
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); $('n').textContent = j.count; $('label').textContent = j.label;
}
$('inc').onclick = () => call('/api/count', { delta: 1 });
$('reset').onclick = () => call('/api/count', { reset: true });
$('ask').onclick = () => fetch('/api/ask-label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const last = localStorage.getItem('hello.lastVisit');   // localStorage works too
$('seen').textContent = last ? 'Last visit: ' + new Date(Number(last)).toLocaleString() : 'First visit';
localStorage.setItem('hello.lastVisit', String(Date.now()));
call('/api/count'); setInterval(() => call('/api/count'), 3000);
</script></body></html>`;

const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const path = new URL(req.url, 'http://x').pathname;

        if (req.method === 'POST' && path === '/vh/callback') {
            // Never trust "it came from loopback": any local process can reach this port.
            if (!verifyEvent({ secret: secret() ?? '', headers: req.headers, rawBody: raw })) return send(res, 401, { error: 'bad signature' });
            const event = JSON.parse(raw.toString('utf8'));
            if (firstTime(event.id)) await handleEvent(event);
            return send(res, 200, { ok: true });
        }

        // Writes must come through Very Happy (signed), unless explicitly running without it.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !INSECURE_LOCAL) {
            const ok = verifyRequest({ secret: secret() ?? '', method: req.method, pathWithQuery: req.url, headers: req.headers, body: raw });
            if (!ok) return send(res, 401, { error: 'unsigned request' });
        }
        if (req.method === 'GET' && path === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
        if (req.method === 'GET' && path === '/api/count') return send(res, 200, { count, label });
        if (req.method === 'POST' && path === '/api/count') {
            const body = JSON.parse(raw.toString('utf8') || '{}');
            setCount(body.reset ? 0 : count + (Number(body.delta) || 0));
            return send(res, 200, { count, label });
        }
        if (req.method === 'POST' && path === '/api/ask-label') {
            await vh('POST', '/decisions', {
                key: 'label', kind: 'input', title: 'Name the counter',
                input: { placeholder: 'e.g. Coffees today', maxLength: 40 }, panelPath: '/',
            });
            return send(res, 202, { asked: true });
        }
        send(res, 404, { error: 'not found' });
    });
}).listen(PORT, '127.0.0.1', async () => {
    console.log(`Hello Board on http://127.0.0.1:${PORT} (session widget: ${SESSION_ID ?? 'off'}, events: ${PULL ? 'pull' : 'push'})`);
    const info = await vh('GET', '/info');
    if (info.status === 200) console.log(`[vh] install ${info.body.installId} ${info.body.state}; grants: ${info.body.grants.join(', ')}`);
    else console.log('[vh] not approved yet: run `very-happy plugin add ./vh-plugin.json` and approve it in the web app.');
    void publish();
    if (PULL) void pullLoop();
});
