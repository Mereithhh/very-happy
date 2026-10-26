import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findDrift, parseLockfilePackages, workspacePackageNames } from './check-image-lockfile.mjs';

const LOCK = `lockfileVersion: '9.0'

importers:

  packages/happy-server:
    dependencies:
      '@peculiar/asn1-x509':
        specifier: ^2.3.8
        version: 2.6.0

packages:

  '@peculiar/asn1-x509@2.6.0':
    resolution: {integrity: sha512-x}

  elevenlabs@1.59.0:
    resolution: {integrity: sha512-y}

  xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
    resolution: {tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}
    version: 0.20.3

snapshots:

  '@peculiar/asn1-x509@2.11.1':
    dependencies: {}
`;
const locked = parseLockfilePackages(LOCK);
const ws = new Set(['@slopus/happy-wire']);
const pkg = (name, version) => ({ name, version, path: `/repo/node_modules/${name}` });

test('B-820 incident: a re-resolved transitive version is drift', () => {
    const drift = findDrift([pkg('@peculiar/asn1-x509', '2.11.1')], locked, ws);
    assert.deepEqual(drift.map((d) => [d.name, d.version, d.locked]), [['@peculiar/asn1-x509', '2.11.1', ['2.6.0']]]);
});

test('locked, workspace, tarball and v-prefixed versions pass', () => {
    const installed = [
        pkg('@peculiar/asn1-x509', '2.6.0'),
        pkg('@slopus/happy-wire', '0.0.0'),
        pkg('xlsx', '0.20.3'),
        pkg('elevenlabs', 'v1.59.0'),
    ];
    assert.deepEqual(findDrift(installed, locked, ws), []);
});

test('a package the lockfile never mentions is drift', () => {
    const [d] = findDrift([pkg('json-with-bigint', '3.5.12')], locked, ws);
    assert.deepEqual(d.locked, []);
});

test('snapshots never count as pinned packages', () => {
    assert.deepEqual([...locked.get('@peculiar/asn1-x509')], ['2.6.0']);
});

test('parses the real lockfile and workspace names', () => {
    const real = parseLockfilePackages(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'));
    assert.ok(real.size > 500);
    assert.ok(workspacePackageNames().has('@slopus/happy-wire'));
});
