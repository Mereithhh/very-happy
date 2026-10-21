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
}

export const HARNESS_INSTALL_CATALOG: Readonly<Record<HarnessInstallId, HarnessInstallEntry>> = Object.freeze({
    claude: Object.freeze({ packages: [{ name: '@anthropic-ai/claude-code', spec: 'latest' }], commands: ['claude'] }),
    codex: Object.freeze({ packages: [{ name: '@openai/codex', spec: 'latest' }], commands: ['codex'] }),
    gemini: Object.freeze({ packages: [{ name: '@google/gemini-cli', spec: 'latest' }], commands: ['gemini'] }),
    pi: Object.freeze({
        packages: [{ name: '@earendil-works/pi-coding-agent', spec: 'latest' }, { name: 'pi-acp', spec: '0.0.33' }],
        commands: ['pi', 'pi-acp'],
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
    const args = ['i', '-g', `--prefix=${prefix}`, '--no-fund', '--no-audit', ...entry.packages.map((p) => `${p.name}@${p.spec}`)];
    if (args.some((arg) => !NPM_SAFE_ARG.test(arg))) throw new Error('Unsafe npm argument');
    return args;
}

/** The equivalent command for a person to run (shown when the daemon cannot install). */
export function harnessInstallCommand(id: HarnessInstallId): string {
    return `npm install -g ${HARNESS_INSTALL_CATALOG[id].packages.map((p) => `${p.name}@${p.spec}`).join(' ')}`;
}
