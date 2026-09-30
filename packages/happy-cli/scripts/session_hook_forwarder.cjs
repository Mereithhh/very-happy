#!/usr/bin/env node
/**
 * Session Hook Forwarder
 * 
 * This script is executed by Claude's SessionStart hook.
 * It reads JSON data from stdin and forwards it to Happy's hook server.
 * 
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [source]
 *
 * `source` (optional, B-515) tags the request as `?source=<source>` so the
 * hook server can tell which Claude process of the wrapper reported it.
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
const source = process.argv[3];
const hookPath = source && /^[A-Za-z0-9_.-]{1,64}$/.test(source)
    ? '/hook/session-start?source=' + encodeURIComponent(source)
    : '/hook/session-start';

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);
    
    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: hookPath,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        }
    }, (res) => {
        res.resume(); // Drain response
    });
    
    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });
    
    req.end(body);
});

process.stdin.resume();

