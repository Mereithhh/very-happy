/**
 * B-354 的两条 memo/节流接线守卫（源码断言）。
 *
 * 两条 bug 都是**只在真实浏览器里才显形**的形状，而本包的渲染测试跑在 node 的
 * `renderToStaticMarkup` 下（不跑 effect、不做 StrictMode 双调用），所以钉的是接线：
 *
 *  ① `useThrottledText` 的卸载清理必须把 `timer.current` 置空。StrictMode 的模拟
 *     卸载/重挂会跑一次 cleanup 但**保留 fiber 上的 ref**，只 clearTimeout 会留下一个
 *     失效 id，此后 `if (timer.current) return` 永远为真、再也不排下一个 tick——
 *     实测 dev 下草稿冻在跨过阈值那一刻的长度。
 *  ② `AgentText` 的 `onOption` 必须 `useCallback`。它进了 `Markdown` 的 parse memo 依赖，
 *     而 `AgentText` 订阅 `session.thinking`（每轮翻两次）——内联箭头函数会让 transcript
 *     里**每一条** agent 消息在每次翻转时全量重新 parse（实测每次重渲 +1 次 parse）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
/** Assertions must not match the prose in a comment that explains the rule. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('streaming throttle + parse memo wiring', () => {
    const markdown = read('./Markdown.tsx');
    const messageView = read('./MessageView.tsx');

    it('the unmount cleanup nulls the timer ref (StrictMode keeps refs)', () => {
        const hook = code(markdown).slice(code(markdown).indexOf('function useThrottledText'));
        const body = hook.slice(0, hook.indexOf('\n}'));
        const cleanup = body.slice(body.lastIndexOf('React.useEffect(() => () =>'));
        expect(cleanup).toContain('clearTimeout(timer.current)');
        expect(cleanup, 'clearing the timeout without clearing the ref freezes every later tick')
            .toContain('timer.current = null');
    });

    it('the rendered tree is memoised, and onOption is part of that memo', () => {
        expect(markdown).toContain('return React.useMemo(() => (');
        expect(markdown).toContain('[segments, components, onOption]');
    });

    it('AgentText passes a STABLE onOption', () => {
        const agentText = messageView.slice(messageView.indexOf('function AgentText'));
        const decl = agentText.slice(agentText.indexOf('const onOption'), agentText.indexOf('if (message.isThinking)'));
        expect(decl, 'an inline arrow re-parses every agent message on each thinking flip')
            .toContain('useCallback(');
        expect(decl).toContain('[sessionId]');
    });

    it('Markdown itself never reads the path-link context', () => {
        // Reading it there would re-render (and therefore re-parse) the whole
        // transcript whenever the agent writes a file.
        const component = markdown.slice(markdown.indexOf('export function Markdown('));
        expect(component.slice(0, component.indexOf('\n}'))).not.toContain('useContext');
    });
});

describe('MessageView memo comparator covers every prop', () => {
    it('a new prop must be added to the comparator (TypeScript will not tell you)', () => {
        const source = read('./MessageView.tsx');
        const propsBlock = source.slice(source.indexOf('}: {', source.indexOf('export const MessageView')));
        const props = [...propsBlock.slice(0, propsBlock.indexOf('\n}')).matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]);
        expect(props.length).toBeGreaterThan(3);
        const comparator = source.slice(source.lastIndexOf('}, (prev, next) => ('));
        for (const prop of props) {
            expect(comparator, `${prop} is not compared — the row would render stale content`).toContain(`prev.${prop}`);
        }
    });
});

describe('MermaidView state machine wiring (B-357)', () => {
    const source = read('./MermaidView.tsx');

    it('the slow-network gate is STATE and is in the effect deps', () => {
        // A ref cannot arm the effect: flipping it does not re-run it, so the
        // "render diagram" button removed itself and rendered nothing (measured
        // in a real browser: renderCalls stayed 0 after the click). That branch
        // only runs behind saveData / 2g-3g, so no desktop check reaches it.
        expect(source).toContain('const [armed, setArmed] = useState(() => !shouldDeferMermaid())');
        expect(source).toContain('}, [code, themeKey, id, armed]);');
        expect(source).toContain('onClick={() => setArmed(true)}');
        expect(source, 'a ref here is exactly the bug').not.toContain('wanted.current');
    });

    it('each render attempt gets its own mermaid id (StrictMode mounts twice)', () => {
        expect(source).toContain('attempt.current += 1;');
        expect(source).toContain('renderMermaid(`${id}-${attempt.current}`');
    });

    it('a draft never renders a diagram', () => {
        const markdown = read('./Markdown.tsx');
        expect(markdown).toContain("if (lang === 'mermaid' && !plainCode) return <MermaidView code={code} />;");
    });
});
