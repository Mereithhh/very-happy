#!/usr/bin/env node
/**
 * B-844 staleness guard for the "follow latest" table
 * (packages/happy-wire/src/latestModels.json).
 *
 * Probes a Codex CLI's bundled `model/list` (empty CODEX_HOME, so no account
 * or remote refresh is involved) and fails when it lists a model of the
 * table's tier (sol) newer than the table head, or when Codex's own default
 * moved to another tier. Claude is guarded by the happy-cli unit test
 * latestModelsFreshness.test.ts against the bundled claude-agent-sdk.
 *
 *   node scripts/dev/check-latest-models.mjs                 # npm `latest` Codex
 *   node scripts/dev/check-latest-models.mjs --codex-version 0.166.0
 *   node scripts/dev/check-latest-models.mjs --codex /usr/bin/codex
 *
 * Runs weekly in .github/workflows/latest-models-check.yml.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../packages/happy-wire/src/latestModels.json');

export function loadTable(path = TABLE_PATH) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function tierVersion(tier, model) {
    const match = new RegExp(tier.pattern).exec(model);
    return match ? match.slice(1).filter((part) => part !== undefined).map(Number) : null;
}

export function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * @param {{ pattern: string, models: { model: string }[] }} tier
 * @param {{ model: string, isDefault?: boolean }[]} catalog
 * @returns {string[]} problems (empty = table is current)
 */
export function findStaleness(tier, catalog) {
    const problems = [];
    const head = tier.models[0]?.model;
    const headVersion = head ? tierVersion(tier, head) : null;
    if (!headVersion) return [`table head ${head ?? '(none)'} does not match its own tier pattern ${tier.pattern}`];
    const newer = catalog
        .map((entry) => entry.model)
        .filter((model) => {
            const version = tierVersion(tier, model);
            return version && compareVersions(version, headVersion) > 0;
        });
    if (newer.length > 0) problems.push(`catalog lists ${newer.join(', ')} newer than table head ${head} — add it to latestModels.json (after a real \`codex exec -m\` run)`);
    const fallbackDefault = catalog.find((entry) => entry.isDefault)?.model;
    if (fallbackDefault && !tierVersion(tier, fallbackDefault)) {
        problems.push(`Codex's own default ${fallbackDefault} is outside the ${tier.tier} tier — check whether the flagship tier changed`);
    }
    return problems;
}

export function probeCodexModels(codexBin, timeoutMs = 60_000) {
    const home = mkdtempSync(join(tmpdir(), 'vh-codex-home-'));
    return new Promise((resolve, reject) => {
        const child = spawn(codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home } });
        const timer = setTimeout(() => { child.kill(); reject(new Error('model/list timed out')); }, timeoutMs);
        let buffer = '';
        const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.id === 1) {
                    send({ method: 'initialized' });
                    send({ id: 2, method: 'model/list', params: {} });
                } else if (message.id === 2) {
                    clearTimeout(timer);
                    child.kill();
                    rmSync(home, { recursive: true, force: true });
                    if (message.error) reject(new Error(JSON.stringify(message.error)));
                    else resolve(message.result.data.map((entry) => ({ model: entry.model, isDefault: entry.isDefault === true })));
                }
            }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'vh-latest-models-check', version: '1' } } });
    });
}

function installCodex(version) {
    const dir = mkdtempSync(join(tmpdir(), 'vh-codex-'));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--prefix', dir, `@openai/codex@${version}`], { stdio: 'inherit' });
    return join(dir, 'node_modules', '.bin', 'codex');
}

async function main(argv) {
    const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const table = loadTable();
    const codexBin = arg('--codex') ?? installCodex(arg('--codex-version') ?? 'latest');
    const version = execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim();
    const catalog = await probeCodexModels(codexBin);
    console.log(`${version}: ${catalog.map((entry) => entry.model + (entry.isDefault ? '*' : '')).join(' ')}`);
    const problems = findStaleness(table.agents.codex, catalog);
    for (const problem of problems) console.error(`STALE codex: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(`latest-models table is current for codex (head ${table.agents.codex.models[0].model})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2)).catch((error) => { console.error(error); process.exit(2); });
}
