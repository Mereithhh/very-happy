import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedStylesheets, liveEntry, referencedAssets } from './check-shipped-assets.mjs';

const sha = 'b25ac13dbd68276ea2da3b07f5d3c6b70ef4647e';
// A post-B-823 build: only the entry carries the SHA (web-v2 build/releaseEntry.ts).
const indexHtml = `<link rel="stylesheet" crossorigin href="/assets/index-Cx9_a-b1.css">
<script type="module" crossorigin src="/assets/index-BNpos-Jt-${sha}.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-react-BtRhu15F.js">`;
const entryBody = `import"./vendor-react-BtRhu15F.js";const a=()=>import("./assets/AppRoot-Dyr_9x.js");`
    + `const b="assets/SessionDetailScreen-BOm-g4iw.js",c="assets/SessionDetailScreen-Q1w2e3.css";`;

test('the live SHA comes from the salted entry', () => {
    assert.deepEqual(liveEntry(indexHtml), { entry: `assets/index-BNpos-Jt-${sha}.js`, sha });
    assert.equal(liveEntry('<script src="/assets/index-hDk2hi1d.js"></script>'), null);
});

test('stylesheets without a SHA are seeded (CSS-only changes)', () => {
    assert.deepEqual(linkedStylesheets(indexHtml), ['assets/index-Cx9_a-b1.css']);
});

test('the walk follows content-hashed chunks and stylesheets', () => {
    assert.deepEqual(referencedAssets(entryBody), [
        'assets/AppRoot-Dyr_9x.js',
        'assets/SessionDetailScreen-BOm-g4iw.js',
        'assets/SessionDetailScreen-Q1w2e3.css',
    ]);
});
