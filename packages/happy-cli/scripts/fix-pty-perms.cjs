/**
 * node-pty ships a `spawn-helper` binary that posix_spawn execs. Some install
 * paths (npm pack/extract of the prebuilt) drop its executable bit, which makes
 * pty.spawn fail at runtime with "posix_spawnp failed". Restore +x here so the
 * web terminal works out of the box on every install. No-op on Windows / when
 * node-pty isn't present.
 */
const fs = require('node:fs');
const path = require('node:path');

try {
    const ptyPkg = require.resolve('node-pty/package.json');
    const base = path.join(path.dirname(ptyPkg), 'prebuilds');
    for (const dir of fs.readdirSync(base)) {
        const helper = path.join(base, dir, 'spawn-helper');
        if (fs.existsSync(helper)) {
            fs.chmodSync(helper, 0o755);
            console.log('[fix-pty-perms] chmod +x', helper);
        }
    }
} catch {
    // node-pty not installed (e.g. resolution miss) — nothing to fix.
}
