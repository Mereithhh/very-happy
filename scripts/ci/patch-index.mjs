// Post-build patch for the exported web index.html.
//
// expo web `output: "single"` does NOT run +html.tsx, so these have to be
// injected into the exported index.html:
//   - <title> → "Very Happy" (brand)
//   - viewport-fit=cover           (iOS safe-area)
//   - #root height:100dvh          (Chrome toolbar obscuring the bottom input)
//   - PWA manifest + apple meta     (iOS Add-to-Home-Screen + Web Push)
//   - brand loading splash          (the JS bundle is large; show a pulsing
//                                     smiley immediately instead of a white
//                                     screen until React mounts)
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

// Brand loading splash: a pulsing smiley shown immediately (HTML paints before
// the deferred JS bundle), removed the moment React commits into #root. Falls
// back to auto-hide after 8s. Background follows prefers-color-scheme so it
// matches the app's light/dark shell instead of flashing white.
if (!s.includes('id="vh-splash"')) {
    const splashStyle = '<style id="vh-splash-style">'
        + '#vh-splash{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;'
        + 'background:#fff;color:#18171C;z-index:2147483647;transition:opacity .35s ease}'
        + '#vh-splash.vh-hide{opacity:0;pointer-events:none}'
        + '#vh-splash svg{width:76px;height:76px;animation:vhpulse 1.4s ease-in-out infinite}'
        + '@keyframes vhpulse{0%,100%{opacity:.5;transform:scale(.92)}50%{opacity:1;transform:scale(1)}}'
        + '@media (prefers-color-scheme:dark){#vh-splash{background:#18171C;color:#fff}}'
        + '</style>';
    s = s.replace('</head>', splashStyle + '</head>');

    const splash = '<div id="vh-splash" aria-label="Loading" role="progressbar">'
        + '<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">'
        + '<circle cx="35.5" cy="40" r="7.5" fill="currentColor"/>'
        + '<circle cx="64.5" cy="40" r="7.5" fill="currentColor"/>'
        + '<path d="M28 52 Q50 80 72 52" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>'
        + '</svg></div>'
        + '<script>(function(){var r=document.getElementById("root"),s=document.getElementById("vh-splash");'
        + 'if(!r||!s)return;function hide(){if(!s)return;s.classList.add("vh-hide");'
        + 'var el=s;setTimeout(function(){el&&el.remove()},400);s=null}'
        + 'var mo=new MutationObserver(function(){if(r.childNodes.length>0){hide();mo.disconnect()}});'
        + 'mo.observe(r,{childList:true});setTimeout(hide,8000)})();</script>';
    s = s.replace('<div id="root"></div>', '<div id="root"></div>' + splash);
}

writeFileSync(p, s);
const ok = ['viewport-fit=cover', 'happy-dvh-fix', 'id="happy-pwa"', 'id="vh-splash"', '<title>Very Happy</title>']
    .every((m) => s.includes(m));
console.log('patched index.html (title+viewport+dvh+pwa+splash):', ok);
if (!ok) process.exit(1);
