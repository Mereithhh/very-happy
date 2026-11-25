import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPiModelsJson } from '@/agent/acp/piContextUsage';
import { piAgentDir } from '@/modules/modelConfig/harnesses/pi';
import { agentExtraPath } from '@/utils/agentBinResolver';
import { sanitizeSpawnModel } from './spawnModel';

/**
 * B-978: the machine's pi model table, read without a session.
 *
 * `pi --list-models` prints `provider model context max-out thinking images`;
 * the code is `provider/id`, the same id pi-acp publishes in session/new. When
 * that command cannot run (pi missing, older pi without the flag, timeout) the
 * table falls back to `models.json` — which only holds providers the user
 * configured by hand: the models pi ships for its built-in providers are
 * missing there, and the Web says so instead of pretending the list is whole.
 */
export type PiModelSource = 'cli' | 'models-json';

export type PiModelEntry = { code: string; value: string; thinking: boolean };

export type PiModelTable = {
  checkedAt: number;
  daemonPid: number;
  /** Where the list came from; `models-json` is the partial fallback. */
  source: PiModelSource;
  models: PiModelEntry[];
};

/** Hard ceiling for the list command; a hung pi must not hold the probe. */
export const PI_LIST_MODELS_TIMEOUT_MS = 10_000;

export function parsePiListModels(output: string): PiModelEntry[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*provider\s+model\b/i.test(line));
  if (header < 0) return [];
  const seen = new Set<string>();
  const models: PiModelEntry[] = [];
  for (const line of lines.slice(header + 1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const code = `${cols[0]}/${cols[1]}`;
    if (!sanitizeSpawnModel(code) || seen.has(code)) continue;
    seen.add(code);
    models.push({ code, value: code, thinking: cols[4].toLowerCase() === 'yes' });
  }
  return models;
}

/**
 * The same table from `models.json` — providers the user configured. pi's
 * built-in providers are not in this file, so this is the partial fallback.
 */
export function parsePiModelsJson(json: unknown): PiModelEntry[] {
  if (!json || typeof json !== 'object') return [];
  const providers = (json as { providers?: unknown }).providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  const seen = new Set<string>();
  const models: PiModelEntry[] = [];
  for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const list = (value as { models?: unknown }).models;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const model = entry as { id?: unknown; name?: unknown; reasoning?: unknown };
      if (typeof model.id !== 'string' || !model.id.trim()) continue;
      const code = `${provider}/${model.id.trim()}`;
      if (!sanitizeSpawnModel(code) || seen.has(code)) continue;
      seen.add(code);
      models.push({
        code,
        value: typeof model.name === 'string' && model.name.trim() ? `${provider}/${model.name}` : code,
        thinking: model.reasoning === true,
      });
    }
  }
  return models;
}

/**
 * The `pi` to run: the copy `agentBinResolver` found (the same one a spawn puts
 * in front of PATH), else the daemon's own PATH. A daemon started by systemd or
 * launchd often cannot see an npm-global / nvm / homebrew pi, which is exactly
 * why the resolver exists (B-956).
 */
export function piListModelsCommand(
  extraPath: readonly string[] = agentExtraPath('pi'),
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const names = platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  for (const dir of extraPath) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return 'pi';
}

type RunPiListModels = (command: string) => Promise<string>;

const runPiListModels: RunPiListModels = (command) => new Promise((resolve, reject) => {
  execFile(command, ['--list-models'], { timeout: PI_LIST_MODELS_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/**
 * Fingerprint of the files pi reads for its registry: a daemon that sees it
 * change re-probes before the 6h tick, without another round of `pi --list-models`.
 */
export function piConfigFingerprint(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = piAgentDir({ home, env });
  return ['models.json', 'settings.json']
    .map((file) => {
      try {
        return String(statSync(join(dir, file)).mtimeMs);
      } catch {
        return '-';
      }
    })
    .join('|');
}

/**
 * Null when nothing could be read: pi missing, the command failing or timing
 * out, and no models.json either. The daemon then keeps the table it published
 * last (an empty list would silently drop every model from the picker).
 */
export async function detectPiModels(
  run: RunPiListModels = runPiListModels,
  now = Date.now(),
  pid = process.pid,
  command: string = piListModelsCommand(),
  readModelsJson: () => unknown = () => readPiModelsJson(),
): Promise<PiModelTable | null> {
  try {
    const models = parsePiListModels(await run(command));
    if (models.length > 0) return { checkedAt: now, daemonPid: pid, source: 'cli', models };
  } catch {
    // fall through to models.json
  }
  const fallback = parsePiModelsJson(readModelsJson());
  return fallback.length > 0 ? { checkedAt: now, daemonPid: pid, source: 'models-json', models: fallback } : null;
}

/**
 * B-978: when to run the probe again. The list command is cheap (~0.3s) but
 * still a process per call, so the daemon re-runs it only when something it
 * depends on moved — the installed pi version, the config files' mtimes, or
 * the resolved `pi` path — or the last good table is older than `maxAgeMs`.
 * A failed probe keeps the last table and is retried on the next tick.
 */
export function createPiModelRefresher(deps: {
  detect: (command: string) => Promise<PiModelTable | null>;
  publish: (table: PiModelTable) => Promise<unknown>;
  key: () => { version: string | null; config: string; command: string };
  log: (message: string) => void;
  now?: () => number;
  maxAgeMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const maxAgeMs = deps.maxAgeMs ?? 6 * 60 * 60 * 1000;
  let lastKey: string | null = null;
  let lastAt = 0;
  let inFlight: Promise<void> | null = null;
  const refresh = (force = false): Promise<void> => {
    inFlight ??= (async () => {
      const k = deps.key();
      const key = `${k.version ?? '?'}#${k.config}#${k.command}`;
      if (!force && key === lastKey && now() - lastAt < maxAgeMs) return;
      const table = await deps.detect(k.command).catch(() => null);
      if (!table) {
        deps.log(`pi model table unavailable (${k.command}); keeping the last one`);
        return;
      }
      await deps.publish(table);
      lastKey = key;
      lastAt = now();
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  return { refresh };
}

/**
 * B-978: the `--model` a relaunch (Web restore, daemon auto-resume, restart)
 * passes. Claude/Codex ids go through the resume sanitizer as before. A pi
 * session (flavor `acp`) keeps its `provider/id` — the resume sanitizer drops
 * the slash — and, when the caller sent no model (Web restore and auto-resume
 * never do), reopens on the model it was running (`metadata.currentModelCode`,
 * published by pi-acp) instead of the machine's pi default.
 */
export function relaunchModel(
  requested: unknown,
  metadata: { flavor?: string | null; currentModelCode?: string | null },
  sanitizeResume: (value: unknown) => string | null,
): string | null {
  const resumed = sanitizeResume(requested);
  if (resumed) return resumed;
  if (metadata.flavor !== 'acp') return null;
  return sanitizeSpawnModel(requested) ?? (requested === undefined ? sanitizeSpawnModel(metadata.currentModelCode) : null);
}
