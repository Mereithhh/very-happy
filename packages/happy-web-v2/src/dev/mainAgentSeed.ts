/** DEV-only (B-916a): main agent scenes for the device shell harness.
 *  `#main-agent` — a live main agent (pointer + transcript with a tool row and options);
 *  `#main-agent-enable` — none yet (enable flow, Linux box recommended over a laptop);
 *  `#main-agent-upgrade` — the pointed machine runs an old CLI (upgrade hint, no spawn);
 *  `#main-agent-oldcli` — a live session whose wrapper lacks `main-agent-gates-v1` (update banner);
 *  `#main-agent-open` / `#main-agent-cards` (B-923) — the desktop column open; `-cards` adds tool cards.
 *  Neutral local example data; nothing is sent. */
import { storage } from '@/sync/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Machine, Session } from '@/sync/storageTypes';
import { useMainAgentStore } from '@/assistant/mainAgentStore';
import { MAIN_AGENT_TOOL_FIXTURE } from '@/screens/mainAgent/toolCards/mainAgentToolFixtures';

export const MAIN_AGENT_SESSION_ID = 'dev-main-agent';
const ZH = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
const L = (zh: string, en: string) => (ZH ? zh : en);

function machine(id: string, host: string, platform: string, version: string, createdAt: number, now: number): Machine {
    return { id, seq: 2, createdAt, updatedAt: now, active: true, activeAt: now,
        metadata: { host, platform, happyCliVersion: version, happyHomeDir: '~/.happy', homeDir: '~', teamLaunchVersion: 1 },
        metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine;
}

function transcript(base: number, cards: boolean): NormalizedMessage[] {
    let seq = 0;
    const at = () => base + seq * 60_000;
    const user = (text: string) => ({ role: 'user', id: `ma-${++seq}`, localId: `ma-q${seq}`, createdAt: at(), isSidechain: false, seq, content: { type: 'text', text } });
    const agent = (text: string) => ({ role: 'agent', id: `ma-${++seq}`, localId: null, createdAt: at(), isSidechain: false, seq, content: [{ type: 'text', text, uuid: `u-${seq}`, parentUUID: null }] });
    const out: unknown[] = [];
    out.push(user(L('今天哪些会话卡住了？', 'Which sessions are stuck today?')));
    seq++;
    out.push({ role: 'agent', id: `ma-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
        content: [{ type: 'tool-call', id: 'ma-call-1', name: 'mcp__happy__sessions_list', input: { filter: 'waiting', limit: 20 }, description: null, uuid: 'tc-ma-1', parentUUID: null }] });
    seq++;
    out.push({ role: 'agent', id: `ma-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
        content: [{ type: 'tool-result', tool_use_id: 'ma-call-1', content: '{"ok":true,"items":3}', is_error: false, uuid: 'tr-ma-1', parentUUID: null }] });
    out.push(agent(L(
        '有 3 个在等你：\n\n- **修复构建里的类型错误**：等你确认改法\n- **发布说明**：草稿写完，等审\n- **退款迁移**：API 错误停住了\n\n<options>\n<option>先看退款迁移</option>\n<option>把发布说明发给我</option>\n</options>',
        'Three are waiting on you:\n\n- **Fix the type errors in the build**: needs your call on the fix\n- **Release notes**: draft done, waiting for review\n- **Refund migration**: stopped on an API error\n\n<options>\n<option>Open the refund migration first</option>\n<option>Send me the release notes</option>\n</options>',
    )));
    // B-923: one main agent tool call per card family (receipts copied from the CLI's real formats)
    const tool = (fixtureId: string) => {
        const t = MAIN_AGENT_TOOL_FIXTURE(fixtureId);
        const callId = `ma-call-${fixtureId}`;
        seq++;
        out.push({ role: 'agent', id: `ma-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
            content: [{ type: 'tool-call', id: callId, name: t.name, input: t.input, description: null, uuid: `tc-${callId}`, parentUUID: null }] });
        seq++;
        out.push({ role: 'agent', id: `ma-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
            content: [{ type: 'tool-result', tool_use_id: callId, content: t.result, is_error: t.state === 'error', uuid: `tr-${callId}`, parentUUID: null }] });
    };
    if (cards) {
        out.push(user(L('把新手指南交给文档组，顺便回复客户那条线程', 'Give the onboarding guide to the docs crew, and reply on the customer thread')));
        tool('lead_delegate-ok');
        tool('session_send-awaiting');
        tool('blocked-third-party');
        tool('session_wrapup-ok');
        out.push(agent(L('指南已交给文档组的 Lead；回复客户需要你在汇报板批准。', 'The guide is with the docs crew\'s Lead; the customer reply waits for your approval on the board.')));
    }
    out.push(user(L('先看退款迁移', 'Open the refund migration first')));
    out.push(agent(L('它在第 3 步撞了上游 429。我建议 10 分钟后让它重试；要现在就派吗？', 'It hit an upstream 429 at step 3. I suggest a retry in 10 minutes — dispatch now?')));
    return out as NormalizedMessage[];
}

export function seedMainAgentScene(hash: string): void {
    if (!hash.startsWith('#main-agent')) return;
    const now = Date.now();
    const box = machine('dev-machine', 'dev-box', 'linux', '0.2.209', now - 90 * 86400_000, now);
    const laptop = machine('dev-laptop', 'laptop', 'darwin', '0.2.209', now - 200 * 86400_000, now);
    const old = machine('dev-old', 'old-box', 'linux', '0.2.10', now - 300 * 86400_000, now);
    storage.getState().applyMachines([box, laptop, old]);
    const st = useMainAgentStore.getState();
    st.reset();
    if (hash === '#main-agent-enable') {
        useMainAgentStore.setState({ pointerStatus: 'ready', pointer: null, configStatus: 'ready' });
        return;
    }
    if (hash === '#main-agent-upgrade') {
        useMainAgentStore.setState({ pointerStatus: 'ready', pointer: { machineId: 'dev-old', sessionId: null, generation: 1, updatedAt: now }, configStatus: 'ready' });
        return;
    }
    const base = now - 30 * 60_000;
    storage.getState().applySessions([{
        id: MAIN_AGENT_SESSION_ID, seq: 1, createdAt: base, updatedAt: now - 60_000, active: true, activeAt: now,
        metadata: { machineId: 'dev-machine', path: '~/.happy/assistant', host: 'dev-box', flavor: 'claude', variant: 'assistant', capabilities: hash === '#main-agent-oldcli' ? [] : ['main-agent-gates-v1'] },
        metadataVersion: 1, agentState: { controlledByUser: false, requests: {} }, agentStateVersion: 1,
        thinking: false, presence: 'online',
    } as unknown as Session]);
    storage.getState().applyMessages(MAIN_AGENT_SESSION_ID, transcript(base, hash === '#main-agent-cards'));
    storage.getState().applyMessagesLoaded(MAIN_AGENT_SESSION_ID);
    useMainAgentStore.setState({
        pointerStatus: 'ready',
        pointer: { machineId: 'dev-machine', sessionId: MAIN_AGENT_SESSION_ID, generation: 1, updatedAt: now },
        configStatus: 'ready',
        config: { skillRoots: ['~/skills', '~/work/team-skills'], deniedTools: ['mcp__*__*send*'] },
        configRaw: { skillRoots: ['~/skills', '~/work/team-skills'], deniedTools: ['mcp__*__*send*'] },
        dockOpen: hash === '#main-agent-open' || hash === '#main-agent-cards',
    });
}
