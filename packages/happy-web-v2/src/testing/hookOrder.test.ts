/**
 * B-678: every component and hook in src calls its hooks unconditionally and
 * before any early return. See hookOrder.ts for the rules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findHookOrderViolations } from './hookOrder';

const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Known exceptions, compared for exact equality: removing one means deleting
 * it here, and a new finding fails the test.
 *  - track/useTrackScreens.ts: dead Expo-era port (expo-router, imported by
 *    nothing); `tracking` is a module constant, so the branch never flips.
 */
const ALLOWED = [
  'track/useTrackScreens.ts:7 conditional useTrackScreens useSegments',
  'track/useTrackScreens.ts:8 conditional useTrackScreens useEffect',
];

describe('findHookOrderViolations', () => {
  it('flags a hook after an early return (the B-678 MachineScreen shape)', () => {
    const src = `export function MachineScreen() {
      const machine = useMachine('m');
      if (!machine) {
        return <Empty />;
      }
      const [busy, setBusy] = useState(null);
      return <div>{busy}</div>;
    }`;
    expect(findHookOrderViolations(src)).toEqual([{ kind: 'after-return', fn: 'MachineScreen', hook: 'useState', line: 6 }]);
  });

  it('flags conditional hooks: if branch, ternary, short-circuit, loop, optional call, React.useX', () => {
    const src = `const Thing = memo(function Thing({ a }) {
      if (a) { useEffect(() => {}); }
      const b = a ? useMemo(() => 1, []) : 0;
      const c = a && useRef(null);
      for (const x of []) useCallback(() => x, []);
      maybe?.(useId());
      if (a) React.useLayoutEffect(() => {});
      return null;
    });`;
    expect(findHookOrderViolations(src).map((f) => `${f.kind} ${f.hook}`)).toEqual([
      'conditional useEffect', 'conditional useMemo', 'conditional useRef',
      'conditional useCallback', 'conditional useId', 'conditional useLayoutEffect',
    ]);
  });

  it('accepts hooks in conditions, nested callbacks, `return useX()` and non-component functions', () => {
    const src = `export function useThing(id) {
      const v = useValue(id);
      if (useFlag()) {}
      const cb = useCallback(() => { if (v) return; useNotAHookHere(); }, [v]);
      return useMemo(() => cb, [cb]);
    }
    function helper(x) { if (!x) return; useWhatever(); }
    const Row = forwardRef((props, ref) => { const s = useState(0); return null; });`;
    expect(findHookOrderViolations(src)).toEqual([]);
  });
});

it('no component or hook under src breaks hook order (B-678)', () => {
  const findings: string[] = [];
  for (const file of walk(SRC)) {
    for (const f of findHookOrderViolations(readFileSync(file, 'utf8'), file)) {
      findings.push(`${relative(SRC, file)}:${f.line} ${f.kind} ${f.fn} ${f.hook}`);
    }
  }
  expect(findings).toEqual(ALLOWED);
});
