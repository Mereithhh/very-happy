#!/usr/bin/env node
// B-820: every package installed in an image's node_modules must be a version
// pinned in pnpm-lock.yaml. `pnpm deploy --legacy` with node-linker=hoisted
// silently re-resolved the whole tree from the registry, so the shipped image
// could contain releases nobody had locked or reviewed.
//
//   node scripts/ci/check-image-lockfile.mjs --image <ref> [--modules <dir>[,<dir>...]]
//   node scripts/ci/check-image-lockfile.mjs --list <installed.json>
//
// Exits 1 and prints every drifted package when the image and lockfile differ.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MODULES = [
    '/repo/node_modules',
    '/repo/packages/happy-server/node_modules',
    '/repo/packages/happy-wire/node_modules',
].join(',');

// Runs inside the image with its own node: prints [{ name, version, path }]
// once per installed package directory (by realpath) under the given
// comma-separated node_modules roots, nested trees and pnpm's .pnpm store
// included. Missing roots are skipped.
export const LISTER = String.raw`
const fs = require('fs'), path = require('path');
const out = [], seen = new Set();
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p); continue; }
    let real, pkg;
    try { real = fs.realpathSync(p); pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8')); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ name: pkg.name, version: pkg.version, path: p });
    walk(path.join(real, 'node_modules'));
  }
}
for (const root of process.argv[1].split(',')) {
  walk(root);
  let store = [];
  try { store = fs.readdirSync(path.join(root, '.pnpm')); } catch {}
  for (const entry of store) walk(path.join(root, '.pnpm', entry, 'node_modules'));
}
process.stdout.write(JSON.stringify(out));
`;

function unquote(s) {
    return s.replace(/^'(.*)'$/, '$1');
}

// name -> Set(version) from the lockfile's `packages:` section. Non-registry
// keys (tarball URLs) carry their real version in a nested `version:` field.
export function parseLockfilePackages(text) {
    const locked = new Map();
    const lines = text.split('\n');
    let inPackages = false;
    let current = null;
    for (const line of lines) {
        if (/^\S/.test(line)) {
            inPackages = line === 'packages:';
            current = null;
            continue;
        }
        if (!inPackages) continue;
        const key = /^ {2}(\S.*):$/.exec(line);
        if (key) {
            const id = unquote(key[1]);
            const at = id.lastIndexOf('@');
            if (at <= 0) throw new Error(`unparseable lockfile package key: ${id}`);
            const name = id.slice(0, at);
            const version = id.slice(at + 1);
            current = { name };
            add(locked, name, version);
            continue;
        }
        const v = /^ {4}version: (.+)$/.exec(line);
        if (v && current) add(locked, current.name, unquote(v[1]));
    }
    if (locked.size === 0) throw new Error('lockfile has no packages section');
    return locked;
}

function add(map, name, version) {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(version);
}

export function workspacePackageNames(root = REPO_ROOT) {
    const names = new Set();
    const pkgsDir = join(root, 'packages');
    const visit = (dir) => {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest)) names.add(JSON.parse(readFileSync(manifest, 'utf8')).name);
    };
    for (const e of readdirSync(pkgsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        visit(join(pkgsDir, e.name));
        if (e.name === 'happy-cli-tools') {
            for (const t of readdirSync(join(pkgsDir, e.name), { withFileTypes: true })) {
                if (t.isDirectory()) visit(join(pkgsDir, e.name, t.name));
            }
        }
    }
    return names;
}

// npm normalizes published versions the way semver.clean does, but a tarball
// keeps the author's raw package.json (elevenlabs ships "v1.59.0").
export function normalizeVersion(version) {
    return String(version).trim().replace(/^[=v]+/, '');
}

// Returns the installed entries whose (name, version) the lockfile never pinned.
export function findDrift(installed, locked, workspaceNames) {
    const drift = [];
    for (const pkg of installed) {
        if (!pkg.name) continue;
        if (workspaceNames.has(pkg.name)) continue;
        const versions = locked.get(pkg.name);
        if (versions?.has(normalizeVersion(pkg.version))) continue;
        drift.push({ ...pkg, locked: versions ? [...versions].sort() : [] });
    }
    return drift.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function parseArgs(argv) {
    const args = { modules: DEFAULT_MODULES, lockfile: join(REPO_ROOT, 'pnpm-lock.yaml') };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[++i];
        if (value === undefined) throw new Error(`${flag} needs a value`);
        if (flag === '--image') args.image = value;
        else if (flag === '--modules') args.modules = value;
        else if (flag === '--lockfile') args.lockfile = value;
        else if (flag === '--list') args.list = value;
        else throw new Error(`unknown flag ${flag}`);
    }
    if (!args.image === !args.list) throw new Error('pass exactly one of --image or --list');
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const installed = args.list
        ? JSON.parse(readFileSync(args.list, 'utf8'))
        : JSON.parse(execFileSync('docker', [
            'run', '--rm', '--network', 'none', '--entrypoint', 'node', args.image, '-e', LISTER, args.modules,
        ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
    if (installed.length === 0) throw new Error(`no packages found under ${args.modules}`);
    const locked = parseLockfilePackages(readFileSync(args.lockfile, 'utf8'));
    const drift = findDrift(installed, locked, workspacePackageNames());
    const source = args.image ?? args.list;
    if (drift.length === 0) {
        console.log(`${source}: ${installed.length} installed packages all match ${args.lockfile}`);
        return;
    }
    console.error(`${source}: ${drift.length} of ${installed.length} installed packages are not pinned by the lockfile:`);
    for (const d of drift) {
        console.error(`  ${d.name}@${d.version}  (lockfile: ${d.locked.join(', ') || 'absent'})  ${d.path}`);
    }
    process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (error) {
        console.error(`check-image-lockfile: ${error.message}`);
        process.exitCode = 2;
    }
}
