#!/usr/bin/env node
// B-872c (QA42 P2-1): N concurrent POST /v1/issues on one account against a
// server backed by real PostgreSQL. PGlite serializes everything, so only a
// real database shows SERIALIZABLE number allocation answering 409
// `transaction_conflict`. Passes when every create succeeds on the first try
// (no client retry here) and the numbers are exactly next..next+N-1.
//
// Usage: node scripts/ci/issues-concurrency-smoke.mjs <baseUrl> <token> [n=16] [rounds=1]

const [base, token, nArg = '16', roundsArg = '1'] = process.argv.slice(2);
if (!base || !token) {
    console.error('usage: issues-concurrency-smoke.mjs <baseUrl> <token> [n] [rounds]');
    process.exit(2);
}
const n = Number(nArg);
const rounds = Number(roundsArg);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function create(i) {
    const res = await fetch(`${base}/v1/issues`, { method: 'POST', headers, body: JSON.stringify({ title: `concurrency ${i}` }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function maxNumber() {
    const res = await fetch(`${base}/v1/issues?limit=1&includeDeleted=1`, { headers });
    if (res.status !== 200) throw new Error(`list answered ${res.status}`);
    const { issues } = await res.json();
    return issues.reduce((max, issue) => Math.max(max, issue.number), 0);
}

for (let round = 1; round <= rounds; round++) {
    const before = await maxNumber();
    const results = await Promise.all(Array.from({ length: n }, (_, i) => create(i)));
    const failed = results.filter(r => r.status !== 200);
    if (failed.length) {
        console.error(`round ${round}: ${failed.length}/${n} creates failed:`, JSON.stringify(failed.map(f => [f.status, f.body])));
        process.exit(1);
    }
    const numbers = results.map(r => r.body.issue.number).sort((a, b) => a - b);
    const expected = Array.from({ length: n }, (_, i) => before + 1 + i);
    if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
        console.error(`round ${round}: numbers ${JSON.stringify(numbers)} are not ${JSON.stringify(expected)}`);
        process.exit(1);
    }
    console.log(`round ${round}: ${n}/${n} concurrent creates succeeded, numbers ${expected[0]}..${expected[n - 1]} contiguous`);
}
