/**
 * Main agent safety settings (B-922) copy — zh / en (mainAgentCopy pattern).
 * Every item says in one plain sentence what happens.
 */
import type { DispatchPolicy, SafetyPreset, ToolPolicy } from '@slopus/happy-wire';

type ToolClass = 'production' | 'outbound' | 'thirdPartyWrite';
type Dispatch = 'dispatchExternal' | 'dispatchProduction';

export interface MainAgentSafetyCopy {
    title: string;
    footer: string;
    upgrade: string;
    needsMachine: string;
    unreadable: string;
    presetLabel: string;
    presets: Record<SafetyPreset, string>;
    presetHint: Record<SafetyPreset, string>;
    customized: (n: number) => string;
    resetCustom: string;
    advanced: string;
    hideAdvanced: string;
    toolClass: Record<ToolClass, string>;
    toolPolicy: Record<ToolPolicy, string>;
    toolEffect: (cls: ToolClass, policy: ToolPolicy) => string;
    dispatch: Record<Dispatch, string>;
    dispatchPolicy: Record<DispatchPolicy, string>;
    dispatchEffect: (key: Dispatch, policy: DispatchPolicy) => string;
    bash: string;
    bashRisk: string;
    fileEdits: string;
    fileEditsRisk: string;
    allowedTools: string;
    allowedToolsEmpty: string;
    allowedToolsHint: string;
    removeAllowed: (tool: string) => string;
    save: string;
    saved: string;
    ownerOnly: string;
    conflict: string;
    failed: string;
    appliesNext: string;
}

const zhClass: Record<ToolClass, string> = { production: '生产类工具（部署、发布、回滚、apply）', outbound: '对外发送类工具（消息、邮件、评论、推送、分享）', thirdPartyWrite: '其他第三方写工具' };
const enClass: Record<ToolClass, string> = { production: 'Production tools (deploy, release, roll back, apply)', outbound: 'Outbound tools (messages, mail, comments, pushes, shares)', thirdPartyWrite: 'Other third-party write tools' };

const zh: MainAgentSafetyCopy = {
    title: '安全',
    footer: '只有你本人在已登录的浏览器里能把这里改松；主 agent 自己和机器上的 token 只能改严。改动在主 agent 下次新开对话时生效。',
    needsMachine: '先在上面选一台机器启用主 agent，再来调整安全设置。',
    upgrade: '运行主 agent 的机器上 CLI 版本太旧，还不支持安全设置，目前一律按「严格」处理。升级那台机器的 CLI 后这里就能选。',
    unreadable: '账号里存的安全设置来自更新的版本，这个页面读不懂，主 agent 会按「严格」处理。保存会用下面的选择覆盖它。',
    presetLabel: '预设',
    presets: { strict: '严格', standard: '标准', loose: '宽松' },
    presetHint: {
        strict: '第三方工具只能读；发送、发布、部署和其他写工具一律拒绝。派活只要有风险就先问你。',
        standard: '只读工具直接用；发送、发布、部署和其他写工具先出卡问你，批准后才执行。派活有风险时先问你。',
        loose: '默认档。第三方工具直接用，发送也直接发；只有部署、发布、回滚这类生产动作先问你。对外派活直接派，生产派活先问你。',
    },
    customized: (n) => `已自定义 ${n} 项`,
    resetCustom: '恢复预设',
    advanced: '高级设置',
    hideAdvanced: '收起高级设置',
    toolClass: zhClass,
    toolPolicy: { deny: '禁用', ask: '先问我', allow: '直接用' },
    toolEffect: (cls, p) => {
        const what = { production: '部署 / 发布 / 回滚这类工具', outbound: '发消息、发邮件、评论、推送这类工具', thirdPartyWrite: '其他会改东西的第三方工具' }[cls];
        return p === 'deny' ? `主 agent 调${what}会被直接拒绝。` : p === 'ask' ? `主 agent 调${what}时先出一张卡，你批准后才执行，一次批准只管同样参数的那一次。` : `主 agent 调${what}不再问你，直接执行。`;
    },
    dispatch: { dispatchExternal: '派活：结果对外可见（external）', dispatchProduction: '派活：写生产（production）' },
    dispatchPolicy: { ask: '先问我', direct: '直接派' },
    dispatchEffect: (key, p) => {
        const what = key === 'dispatchExternal' ? '会对外发出东西的任务' : '会写生产的任务';
        return p === 'ask' ? `主 agent 派${what}前先在「需要我决策」等你批准。` : `主 agent 派${what}不再问你，直接交给别的会话去做。`;
    },
    bash: '允许主 agent 用 Bash',
    bashRisk: '风险：Bash 能跑任何命令，包括直接调用外部接口发消息、改文件、碰生产，上面的出站规则管不住它。',
    fileEdits: '允许主 agent 直接改文件（Edit / Write）',
    fileEditsRisk: '风险：主 agent 会在本机直接改文件，不再只是派给别的会话去改。',
    allowedTools: '已允许的工具',
    allowedToolsEmpty: '还没有。在卡片上选「以后都允许这个工具」后会出现在这里。',
    allowedToolsHint: '这些工具在「先问我」时不再出卡；「禁用」仍然生效。',
    removeAllowed: (t) => `移除 ${t}`,
    save: '保存安全设置',
    saved: '安全设置已保存',
    ownerOnly: '这次登录不是浏览器登录，服务器不允许它把安全设置改松。请在已登录的浏览器里改，或退出后重新登录再试。',
    conflict: '设置刚被别处改过，请刷新后再改。',
    failed: '保存失败，请稍后重试。',
    appliesNext: '主 agent 下次新开对话时生效',
};

const en: MainAgentSafetyCopy = {
    title: 'Safety',
    footer: 'Only you, in a signed-in browser, can loosen these. The main agent itself and machine tokens can only make them stricter. Changes apply on the main agent\'s next new conversation.',
    needsMachine: 'Enable the main agent on a machine above first, then adjust its safety here.',
    upgrade: 'The CLI on the machine running the main agent is too old for safety settings, so everything runs as Strict. Update that machine\'s CLI to choose here.',
    unreadable: 'The saved safety setting comes from a newer version this page cannot read; the main agent treats it as Strict. Saving replaces it with the choices below.',
    presetLabel: 'Preset',
    presets: { strict: 'Strict', standard: 'Standard', loose: 'Loose' },
    presetHint: {
        strict: 'Third-party tools are read-only; sending, publishing, deploying and other writes are refused. Risky dispatches ask you first.',
        standard: 'Read-only tools just run; sending, publishing, deploying and other writes post a card and run only after you approve. Risky dispatches ask you first.',
        loose: 'The default. Third-party tools just run, sends included; only deploy / release / rollback-type production actions ask you. External dispatches go straight out, production ones ask you.',
    },
    customized: (n) => `${n} item(s) customized`,
    resetCustom: 'Reset to preset',
    advanced: 'Advanced',
    hideAdvanced: 'Hide advanced',
    toolClass: enClass,
    toolPolicy: { deny: 'Block', ask: 'Ask me', allow: 'Allow' },
    toolEffect: (cls, p) => {
        const what = { production: 'deploy / release / rollback tools', outbound: 'message, mail, comment and push tools', thirdPartyWrite: 'other third-party tools that change things' }[cls];
        return p === 'deny' ? `The main agent is refused when it calls ${what}.` : p === 'ask' ? `Calling ${what} posts a card first; it runs after you approve, and one approval covers that exact call only.` : `The main agent calls ${what} without asking you.`;
    },
    dispatch: { dispatchExternal: 'Dispatch: visible outside (external)', dispatchProduction: 'Dispatch: writes production' },
    dispatchPolicy: { ask: 'Ask me', direct: 'Dispatch' },
    dispatchEffect: (key, p) => {
        const what = key === 'dispatchExternal' ? 'tasks that send something outside' : 'tasks that write production';
        return p === 'ask' ? `Before handing off ${what}, the main agent waits for your approval on the decision board.` : `The main agent hands off ${what} to other sessions without asking you.`;
    },
    bash: 'Let the main agent use Bash',
    bashRisk: 'Risk: Bash runs any command — it can call outside services, change files or touch production directly, and the outbound rules above cannot see it.',
    fileEdits: 'Let the main agent edit files (Edit / Write)',
    fileEditsRisk: 'Risk: the main agent edits files on this machine itself instead of only dispatching the work.',
    allowedTools: 'Always-allowed tools',
    allowedToolsEmpty: 'None yet. Choosing "Always allow this tool" on a card adds it here.',
    allowedToolsHint: 'These skip the card when set to "Ask me"; "Block" still applies.',
    removeAllowed: (t) => `Remove ${t}`,
    save: 'Save safety settings',
    saved: 'Safety settings saved',
    ownerOnly: 'This sign-in is not a browser login, so the server will not let it loosen safety settings. Change them in a signed-in browser, or sign out and back in.',
    conflict: 'Someone just changed these settings; reload and try again.',
    failed: 'Could not save; try again shortly.',
    appliesNext: 'Applies on the main agent\'s next new conversation',
};

export function mainAgentSafetyCopy(lang: string): MainAgentSafetyCopy {
    return lang.startsWith('zh') ? zh : en;
}
