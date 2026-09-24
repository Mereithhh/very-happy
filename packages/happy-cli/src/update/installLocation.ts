/**
 * B-489 — where the running CLI is installed, and whether `npm -g` lands there.
 *
 * Found on a SageMaker dev box: the daemon ran from
 * `~/.local/lib/node_modules/very-happy-cli`, but the `npm` on its PATH was
 * conda's, whose global prefix is `/opt/conda`. Every automatic install (0.2.148,
 * 0.2.149) exited 0 into `/opt/conda`, was reported `installed`, and the daemon
 * sat on 0.2.144 for two days: nothing had replaced the bundle it watches, and
 * `installed` is terminal, so nobody was told. The fix is to derive the prefix
 * from the package that is actually running and to say so when that is not
 * possible, never to trust npm's default.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

/** Same allowlist `runNpmProcess` enforces; a prefix outside it cannot be passed to npm. */
export const NPM_SAFE_ARG = /^[A-Za-z0-9@=.,+/_-]+$/;

/**
 * `<prefix>/lib/node_modules/very-happy-cli` → `<prefix>`. Any other layout
 * (pnpm store, `npm link` checkout, Windows `<prefix>/node_modules`) → null:
 * installing somewhere we guessed is how this bug happened.
 */
export function globalPrefixForPackage(packageDir: string): string | null {
    if (!isAbsolute(packageDir)) return null;
    const dir = resolve(packageDir);
    const nodeModules = dirname(dir);
    const lib = dirname(nodeModules);
    const prefix = dirname(lib);
    if (basename(dir) !== 'very-happy-cli' || basename(nodeModules) !== 'node_modules' || basename(lib) !== 'lib') return null;
    if (prefix === lib || resolve(prefix) === '/' || !NPM_SAFE_ARG.test(prefix)) return null;
    return prefix;
}

/** Real path of a `very-happy` bin → the package it belongs to, or null. */
export function packageDirForBin(realBin: string): string | null {
    const packageDir = dirname(dirname(realBin));
    return basename(dirname(realBin)) === 'bin' && basename(packageDir) === 'very-happy-cli' ? packageDir : null;
}

export interface InstallLocationFacts {
    /** The package this process runs from (`projectPath()`, already a real path). */
    runningPackageDir: string;
    /** Real paths of every `very-happy` executable on PATH, in PATH order. */
    onPath: string[];
    /** `npm prefix -g` as the shell would run it, or null when npm is unavailable. */
    npmGlobalPrefix: string | null;
}

export function installLocationWarnings(facts: InstallLocationFacts, version?: string): string[] {
    const warnings: string[] = [];
    const running = resolve(facts.runningPackageDir);
    const packages = [...new Set(facts.onPath.map(packageDirForBin).filter((dir): dir is string => Boolean(dir)).map((dir) => resolve(dir)))];
    if (packages.length > 1) {
        warnings.push(`Found ${packages.length} very-happy installs on PATH (first one wins): ${packages.join(', ')}. Updating one does not update the others; remove the ones you do not use.`);
    }
    if (packages[0] && packages[0] !== running) {
        warnings.push(`The very-happy command runs ${packages[0]}, but this CLI runs from ${running}.`);
    }
    const prefix = globalPrefixForPackage(running);
    if (prefix && facts.npmGlobalPrefix && resolve(facts.npmGlobalPrefix) !== resolve(prefix)) {
        const target = version ? `very-happy-cli@${version}` : 'very-happy-cli@latest';
        warnings.push(`npm install -g writes to ${facts.npmGlobalPrefix}, but this CLI runs from ${prefix}; a plain update will not take effect. Update with: npm install -g --prefix ${prefix} --allow-scripts=very-happy-cli,node-pty ${target} && very-happy daemon start`);
    }
    return warnings;
}

/** Impure half for `doctor` / `daemon status`: bounded, read-only, never throws. */
export function gatherInstallLocationFacts(runningPackageDir: string, env: NodeJS.ProcessEnv = process.env): InstallLocationFacts | null {
    if (process.platform === 'win32') return null;
    const onPath: string[] = [];
    for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        try {
            const candidate = join(dir, 'very-happy');
            if (!statSync(candidate).isFile()) continue;
            const real = realpathSync(candidate);
            if (!onPath.includes(real)) onPath.push(real);
        } catch { /* not on this PATH entry */ }
    }
    let npmGlobalPrefix: string | null = null;
    try {
        const result = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5_000, env });
        const out = result.status === 0 ? result.stdout.trim() : '';
        npmGlobalPrefix = out && isAbsolute(out) && !out.includes('\n') ? out : null;
    } catch { /* npm missing */ }
    return { runningPackageDir, onPath, npmGlobalPrefix };
}
