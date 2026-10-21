// B-661: resource-budget defaults follow production (vh-sg + RDS through PgBouncer),
// the DB credential never reaches argv, and every query runs read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArgs, psqlRemoteCommand, readOnlySql } from './resource-budget.mjs';

test('defaults are the live topology, not the retired vh-us container', () => {
    const o = parseArgs([]);
    assert.equal(o.host, 'vh-sg');
    assert.equal(o.container, 'vh-pgbouncer');
    assert.equal(o.rds, 'vh-pg');
    assert.equal(o.region, 'ap-southeast-1');
    assert.notEqual(o.container, 'happy-postgres');
    assert.equal(parseArgs(['--rds', 'none', '--host', 'self']).rds, 'none');
});

test('the credential comes from the server env over stdin, never from argv', () => {
    const cmd = psqlRemoteCommand('vh-pgbouncer', 'happy-server-green');
    assert.match(cmd, /docker exec happy-server-green printenv DATABASE_URL; cat; \} \| docker exec -i vh-pgbouncer sh -c /);
    assert.doesNotMatch(cmd, /postgres(ql)?:\/\//);
    assert.doesNotMatch(cmd, /POSTGRES_USER|-U /);
});

test('the inner script strips Prisma query params before psql sees the URL', () => {
    const cmd = psqlRemoteCommand('c', 's');
    const inner = cmd.slice(cmd.indexOf("sh -c '") + 7, -1).replace('exec psql', 'printf "%s|" ').replace(/ -X .*$/, '');
    const out = execFileSync('sh', ['-c', inner], {
        input: 'postgresql://u:p@vh-pgbouncer:6432/happy?schema=public&connection_limit=20&pgbouncer=true\nSELECT 1;\n',
        encoding: 'utf8',
    });
    assert.equal(out, 'postgresql://u:p@vh-pgbouncer:6432/happy|');
});

test('every query is wrapped in a read-only transaction', () => {
    assert.equal(readOnlySql('SELECT 1'), 'BEGIN READ ONLY;\nSELECT 1;\nCOMMIT;\n');
    assert.equal(readOnlySql('\nSELECT 1;\n  '), 'BEGIN READ ONLY;\nSELECT 1;\nCOMMIT;\n');
});
