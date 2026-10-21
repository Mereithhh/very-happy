import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnguardedHovers } from './check-design-lint.mjs';
import { migrateHover } from './codemod-hover-guard.mjs';

const G = '@media (hover: hover) and (pointer: fine)';

test('single-line rule is wrapped in place on one line', () => {
    const { output } = migrateHover('.a { x: y; }\n.a:hover { color: var(--text); }\n.a.is-on { color: var(--accent); }\n');
    assert.equal(output, `.a { x: y; }\n${G} { .a:hover { color: var(--text); } }\n.a.is-on { color: var(--accent); }\n`);
});

test('multi-line rule keeps its position and the file indent unit', () => {
    const { output } = migrateHover('.a:hover {\n    color: var(--text);\n}\n.b { x: y; }\n');
    assert.equal(output, `${G} {\n    .a:hover {\n        color: var(--text);\n    }\n}\n.b { x: y; }\n`);
});

test('combined selector is split: the non-hover half stays, the hover half is guarded right after', () => {
    const { output, notes } = migrateHover('.a:hover, .a[data-state=open] { background: var(--fill); }\n');
    assert.equal(output, `.a[data-state=open] { background: var(--fill); }\n${G} { .a:hover { background: var(--fill); } }\n`);
    assert.deepEqual(notes, []);
    const mix = migrateHover('.a:hover, .a:focus-visible { box-shadow: none; }\n');
    assert.equal(mix.notes[0].kind, 'focus-mix');
});

test('adjacent hover rules share one guard; already-guarded and coarse rules are left alone', () => {
    const src = '.a:hover { x: y; }\n.b:hover { x: y; }\n@media (hover: hover) { .c:hover { x: y; } }\n@media (pointer: coarse) { .d:hover { x: y; } }\n';
    const { output, notes } = migrateHover(src);
    assert.equal(output, `${G} {\n  .a:hover { x: y; }\n  .b:hover { x: y; }\n}\n@media (hover: hover) { .c:hover { x: y; } }\n@media (pointer: coarse) { .d:hover { x: y; } }\n`);
    assert.deepEqual(notes.map(n => n.kind), ['coarse']);
});

test('nested in another media query, wrapping nests a guard; hover-reveal is reported', () => {
    const { output, notes } = migrateHover('@media (max-width: 600px) {\n  .row:hover .x { opacity: 1; }\n}\n');
    assert.equal(output, `@media (max-width: 600px) {\n  ${G} { .row:hover .x { opacity: 1; } }\n}\n`);
    assert.equal(notes[0].kind, 'reveal');
});

test('idempotent, and the result passes the hover-unguarded lint', () => {
    const src = '.a:hover, .a:focus-visible { x: y; }\n.b:hover {\n  x: y;\n}\n';
    const once = migrateHover(src).output;
    assert.equal(migrateHover(once).output, once);
    assert.deepEqual(findUnguardedHovers(once), []);
});
