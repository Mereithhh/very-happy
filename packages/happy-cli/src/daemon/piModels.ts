import { execFile } from 'node:child_process';
import { sanitizeSpawnModel } from './spawnModel';

/**
 * B-978: the machine's pi model table, read without a session.
 * `pi --list-models` prints `provider model context max-out thinking images`;
 * the code is `provider/id`, the same id pi-acp publishes in session/new.
 */
export type PiModelEntry = { code: string; value: string; thinking: boolean };
export type PiModelTable = { checkedAt: number; daemonPid: number; models: PiModelEntry[] };

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

type RunPi = () => Promise<string>;

const runPiListModels: RunPi = () => new Promise((resolve, reject) => {
  execFile('pi', ['--list-models'], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** Null when pi is missing or fails: the Web then keeps showing only `default`. */
export async function detectPiModels(run: RunPi = runPiListModels, now = Date.now(), pid = process.pid): Promise<PiModelTable | null> {
  try {
    const models = parsePiListModels(await run());
    return { checkedAt: now, daemonPid: pid, models };
  } catch {
    return null;
  }
}
