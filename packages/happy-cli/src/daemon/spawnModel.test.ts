import { expect, it } from 'vitest';
import { sanitizeSpawnModel } from './spawnModel';
it('accepts provider model ids and excludes flags and shell syntax', () => {
  expect(sanitizeSpawnModel('llm-hub/claude-fable-5-1')).toBe('llm-hub/claude-fable-5-1');
  for (const value of ['--model', 'x;echo', 'x$(pwd)', 'a b', '', null]) expect(sanitizeSpawnModel(value)).toBeNull();
});
