// Post-build patch for the exported web index.html.
//
// expo web `output: "single"` does NOT run +html.tsx, so these have to be
// injected into the exported index.html:
//   - <title> → "Very Happy" (brand)
//   - viewport-fit=cover           (iOS safe-area)
//   - #root height:100dvh          (Chrome toolbar obscuring the bottom input)
//   - PWA manifest + apple meta     (iOS Add-to-Home-Screen + Web Push)
//
// Usage: node scripts/ci/patch-index.mjs <path-to-index.html>

import { readFileSync, writeFileSync } from 'node:fs';

const p = process.argv[2];
if (!p) {
    console.error('usage: patch-index.mjs <index.html>');
    process.exit(1);
}
let s = readFileSync(p, 'utf8');

// Brand title.
s = s.replace(/<title>.*?<\/title>/s, '<title>Very Happy</title>');

if (!s.includes('viewport-fit=cover')) {
    s = s.replace('shrink-to-fit=no', 'shrink-to-fit=no, viewport-fit=cover');
}
if (!s.includes('happy-dvh-fix')) {
    const style = '<style id="happy-dvh-fix">html,body{height:100dvh !important}#root{height:100dvh !important;min-height:100dvh !important}</style>';
    s = s.replace('</head>', style + '</head>');
}
if (!s.includes('id="happy-pwa"')) {
    const pwa = '<link id="happy-pwa" rel="manifest" href="/manifest.json">'
        + '<meta name="theme-color" content="#000000">'
        + '<meta name="apple-mobile-web-app-capable" content="yes">'
        + '<meta name="mobile-web-app-capable" content="yes">'
        + '<meta name="apple-mobile-web-app-status-bar-style" content="black">'
        + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    s = s.replace('</head>', pwa + '</head>');
}

writeFileSync(p, s);
const ok = ['viewport-fit=cover', 'happy-dvh-fix', 'id="happy-pwa"', '<title>Very Happy</title>']
    .every((m) => s.includes(m));
console.log('patched index.html (title+viewport+dvh+pwa):', ok);
if (!ok) process.exit(1);
