/**
 * B-813 review S6: the Web message cache (happy-web-v2 sync/cache) treats an
 * `after_seq` range result as complete and ignores point pushes at or below
 * its lastSeq. That holds only while a session's seqs are allocated under the
 * Session row lock and commit in seq order: a seq allocated outside the lock
 * can commit after a higher one, and a reader in between skips it for good.
 *
 * The lock order is not observable on PGlite (one connection), so this pins
 * the source shape of the single writer instead.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcesDir = join(__dirname, '..', '..');
const storePath = join(__dirname, 'sessionMessageStore.ts');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [path] : [];
    });
}

describe('session seq allocation order (cache coverage premise)', () => {
    it('sessionMessageStore is the only place that allocates session seqs or creates message rows', () => {
        const writers = sourceFiles(sourcesDir)
            .filter((path) => /allocateSessionSeq(Batch)?\(|sessionMessage\.create(Many)?\(/.test(readFileSync(path, 'utf8').replace(/^export async function allocateSessionSeq.*$/gm, '')))
            .map((path) => path.slice(sourcesDir.length + 1));
        expect(writers).toEqual(['app/api/sessionMessageStore.ts']);
    });

    it('locks the Session row, then allocates seqs in the same transaction, then inserts', () => {
        const source = readFileSync(storePath, 'utf8');
        const body = source.slice(source.indexOf('export async function storeSessionMessagesInTx('));
        const lock = body.search(/FROM "Session"\s+WHERE "id" = \$1 AND "accountId" = \$2\s+FOR UPDATE/);
        const allocate = body.indexOf('allocateSessionSeqBatch(options.sessionId, newMessages.length, tx)');
        const insert = body.indexOf('tx.sessionMessage.create(');
        expect(lock).toBeGreaterThan(0);
        expect(allocate).toBeGreaterThan(lock);
        expect(insert).toBeGreaterThan(allocate);
    });
});
