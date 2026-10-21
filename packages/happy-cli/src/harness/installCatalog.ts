/**
 * B-719 — the ONLY npm packages a daemon will install on the owner's behalf.
 *
 * The Web (and the relay in between) can name a harness id from
 * HARNESS_INSTALL_IDS and nothing else: no package names, versions, flags or
 * commands travel over the wire. Each entry is what that harness needs to be
 * spawnable by Very Happy — pi needs both `pi` and the `pi-acp` adapter the
 * runner drives it through, pinned to the adapter version the runner was
 * verified against (pi-acp 0.0.33, see agent/acp/piExtensionDialogs.ts).
 *
 * Structured Claude sessions need nothing here: the Agent SDK bundles its own
 * Claude Code binary. `claude` installs the separate CLI that native terminal
 * sessions (`very-happy` without arguments) run.
 */
import type { HarnessInstallId } from '@slopus/happy-wire';
import { NPM_SAFE_ARG } from '@/update/installLocation';

export interface HarnessPackage {
    readonly name: string;
    /** An exact version or the `latest` dist-tag — never a range typed by a user. */
    readonly spec: string;
}

export interface HarnessInstallEntry {
    readonly packages: readonly HarnessPackage[];
    /** Executables that must resolve on PATH afterwards for the harness to be usable. */
    readonly commands: readonly string[];
    /** Lowest Node the packages declare in `engines` — refused up front instead of installed-but-broken. */
    readonly minNode: string;
    /**
     * Whether the packages need their npm lifecycle scripts. Only claude-code
     * does (postinstall places the native binary); the others ship no install
     * scripts, so npm runs with --ignore-scripts and nothing from the registry
     * executes during the install.
     */
    readonly scripts: boolean;
}

export const HARNESS_INSTALL_CATALOG: Readonly<Record<HarnessInstallId, HarnessInstallEntry>> = Object.freeze({
    claude: Object.freeze({ packages: [{ name: '@anthropic-ai/claude-code', spec: 'latest' }], commands: ['claude'], minNode: '22.0.0', scripts: true }),
    codex: Object.freeze({ packages: [{ name: '@openai/codex', spec: 'latest' }], commands: ['codex'], minNode: '16.0.0', scripts: false }),
    gemini: Object.freeze({ packages: [{ name: '@google/gemini-cli', spec: 'latest' }], commands: ['gemini'], minNode: '20.0.0', scripts: false }),
    pi: Object.freeze({
        packages: [{ name: '@earendil-works/pi-coding-agent', spec: 'latest' }, { name: 'pi-acp', spec: '0.0.33' }],
        commands: ['pi', 'pi-acp'],
        minNode: '22.19.0',
        scripts: false,
    }),
});

/**
 * The npm argv for one harness. Global install into `prefix` (the tree the
 * running CLI lives in — same rule as B-489's self-update), never via a shell,
 * every argument re-checked against the npm-process allowlist.
 */
export function harnessInstallArgs(id: HarnessInstallId, prefix: string): string[] {
    const entry = HARNESS_INSTALL_CATALOG[id];
    if (!entry) throw new Error('Unknown harness');
    const args = ['i', '-g', `--prefix=${prefix}`, '--no-fund', '--no-audit', ...(entry.scripts ? [] : ['--ignore-scripts']), ...entry.packages.map((p) => `${p.name}@${p.spec}`)];
    if (args.some((arg) => !NPM_SAFE_ARG.test(arg))) throw new Error('Unsafe npm argument');
    return args;
}

/** The equivalent command for a person to run (shown when the daemon cannot install). */
export function harnessInstallCommand(id: HarnessInstallId): string {
    return `npm install -g ${HARNESS_INSTALL_CATALOG[id].packages.map((p) => `${p.name}@${p.spec}`).join(' ')}`;
}

/** `20.11.1` / `v22.19.0` → [major, minor, patch]; anything else → null. */
function parseNode(version: string): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `current` satisfies the harness's minimum Node; an unparsable version is refused. */
export function nodeSatisfies(current: string, minimum: string): boolean {
    const a = parseNode(current); const b = parseNode(minimum);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
}
