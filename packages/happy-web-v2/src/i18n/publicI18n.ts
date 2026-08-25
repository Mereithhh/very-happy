import { useSyncExternalStore } from 'react';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from '@/text/_all';
import {
  LANGUAGE_CHANGE_EVENT,
  browserLanguageTags,
  readStoredPreferredLanguage,
  resolveLanguageFromTags,
  setDocumentLanguage,
} from './localeCore';

const en = {
  pwa: {
    eyebrow: 'WORK ANYWHERE // WEB APP', title: 'Install Very Happy',
    nativeBody: 'Launch the standalone workspace from your Home Screen—no browser-tab hunt required.',
    manualBody: 'Open the standalone workspace from your Home Screen. It uses the same account and relay.',
    install: 'Install web app', later: 'Not now', done: 'Got it',
    iosOne: 'Tap Share in your browser toolbar', iosTwo: 'Choose Add to Home Screen',
    manualOne: 'Open your browser menu', manualTwo: 'Choose Install app or Add to Home screen',
    close: 'Close install prompt', pending: 'Opening…',
  },
  shell: {
    skip: 'Skip to content', homeLabel: 'Very Happy home', navLabel: 'Primary navigation',
    docs: 'Docs', signIn: 'Sign in', getStarted: 'Get started', language: 'Language', automatic: 'Automatic',
    footerTagline: 'Very Happy · work anywhere, keep the thread', footerLabel: 'Footer navigation',
    security: 'Security', privacy: 'Privacy', terms: 'Terms', source: 'Source',
  },
  landing: {
    pageTitle: 'Very Happy — One panel for every machine and agent.',
    heroEyebrow: 'MULTI-MACHINE COMMAND PANEL',
    heroTitleA: 'One panel.', heroTitleB: 'Every machine.', heroTitleC: 'Every agent.',
    heroBody: 'Open the Web or PWA, choose a connected machine and agent, then dispatch the work. Step into any live terminal, conversation, file, or task without rebuilding context.',
    thesisA: 'SEE THE FLEET.', thesisB: 'DISPATCH THE WORK. STEP IN ANYWHERE.',
    primaryCta: 'Connect your first machine', secondaryCta: 'See how it works',
    metaWeb: 'Web / PWA command surface', metaChoice: 'Regional relay routing', metaHost: 'self-hostable',
    productEyebrow: 'REAL PRODUCT // SANITIZED DATA', productTitle: 'See the fleet. Open the work.',
    productBody: 'This is the interface you actually use: sessions from multiple machines in one sidebar, with the live terminal, structured Claude mirror, files, previews, and task board one click away.',
    webRecommended: 'WEB / PWA · RECOMMENDED', webRecommendedBody: 'The recommended daily command surface on desktop, tablet, and phone.',
    bridge: 'CLI + DAEMON + TMUX', bridgeBody: 'The machine-side bridge keeps ordinary xterm-256color text TUIs—not only coding agents—reachable.',
    agents: 'AGENT FABRIC · SHIPPED + BETA + ROADMAP',
    agentsBody: 'Claude Code deep support · Codex available · Gemini available from Web through a compatible ACP stdio endpoint (BETA · IMPLEMENTED) · OpenCode through the CLI ACP beta · any text TUI. Pi + provider gateway remain roadmap; today you explicitly choose a Web-supported machine and agent.',
    architecture: 'Architecture', matrix: 'Agent and MCP matrix',
    relayEyebrow: 'REGIONAL RELAY PLANE // LATENCY IS A ROUTING PROBLEM',
    relayTitleA: 'Keep the control plane central.', relayTitleB: 'Move the terminal path closer.',
    relayBody: 'The daemon probes every operator-configured relay and anchors to the lowest measured healthy RTT. The browser follows that machine assignment with a short-lived scoped token, so terminal bytes and machine RPC stop detouring through the data server.',
    relayFactRtt: 'REAL RTT · NOT GEOIP GUESSING', relayFactVisible: 'RELAY + LATENCY VISIBLE IN TERMINAL',
    relayFactFallback: 'LEGACY FALLBACK · WEBRTC NEXT', relayLink: 'Inspect the data flow',
    startEyebrow: 'FIRST CONNECTION // THREE MOVES', startTitle: 'From account to live work.',
    startBody: 'Verify your email once, connect a machine, then work from the Web or installed PWA.',
    stepOne: 'Verify your email', stepOneBody: 'Enter an email code to sign in. If the email is new and registration is open, the account is created automatically. Google and optional password login remain available when enabled by the relay.',
    stepTwo: 'Prepare the machine', stepTwoBody: 'Node 20.19+ within 20.x, 22.13+ within 22.x, or 24+ is required. Configure the local agent; tmux is recommended for durable terminals.',
    stepThree: 'Connect and keep it online', stepThreeBody: 'Then open Web → New session and choose the machine plus agent.',
    quickStart: 'Complete quick start', deploymentEyebrow: 'DEPLOYMENT CHOICE',
    deploymentTitle: 'Cloud convenience or your own infrastructure.',
    deploymentBody: 'Start immediately with Very Happy Cloud, or run the same open-source stack yourself when you need your own access policy, storage, backups, and operational controls.',
    cloud: 'Very Happy Cloud', cloudBody: 'Fastest start · capacity-limited · no uptime SLA', cloudLabel: 'Read the Very Happy Cloud guide',
    selfHosted: 'Self-hosted', selfHostedBody: 'Your operator, access policy, storage, and backups', selfHostedLabel: 'Read the self-hosting guide',
    securityDetails: 'Privacy and security details',
    finalEyebrow: 'WHY VERY HAPPY // WORK ANYWHERE', finalTitleA: 'The interface carries the overhead.', finalTitleB: 'You get to be Very Happy.',
    finalBody: 'Fewer tabs to patrol, less context to rebuild, and more attention left for the decisions only you can make.', viewSource: 'View source',
  },
  docs: {
    chaptersLabel: 'Documentation chapters', pageTitle: 'Documentation — Very Happy', notFoundTitle: 'Not found — Very Happy Docs',
    missingEyebrow: '404 // DOC NOT FOUND', missingTitle: 'That chapter is not here.', missingBody: 'The documentation may have moved.', home: 'Documentation home',
    mobileTitle: 'Documentation', toggle: 'Toggle chapters', eyebrow: 'DOCUMENTATION',
    aside: 'Choose Cloud or self-hosting for your environment.', asideLink: 'Privacy and security.',
    onThisPage: 'ON THIS PAGE', fieldManual: 'THE FIELD MANUAL', indexTitleA: 'Build from anywhere.', indexTitleB: 'Operate with clarity.',
    indexLead: 'Connect a machine, choose an agent, and keep the system healthy from Web or an installed PWA.',
    guides: 'FOCUSED GUIDES · ONE WORKSPACE', interfaceEyebrow: 'THE INTERFACE IN THIS GUIDE', interfaceTitle: 'Learn the product you will actually use.',
    interfaceBody: "The interface below uses the authenticated app's production component styles and Console tokens with sanitized fixture data.",
    openGuide: 'Open guide', fieldGuide: 'FIELD GUIDE', adjacent: 'Adjacent chapters', end: 'Keep the thread.',
    groups: { start: 'Start', understand: 'Understand', operate: 'Operate', extend: 'Extend' },
  },
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
type PublicCopy = Widen<typeof en>;

const zhHans: PublicCopy = {
  pwa: {
    eyebrow: '随时工作 // WEB APP', title: '把 Very Happy 装到手机',
    nativeBody: '从主屏幕一键进入独立工作区，不需要先找到浏览器标签页。',
    manualBody: '从主屏幕直接进入独立工作区；安装后仍使用同一个账号和中继。',
    install: '安装 Web App', later: '暂不', done: '知道了',
    iosOne: '点浏览器工具栏里的“分享”', iosTwo: '选择“添加到主屏幕”',
    manualOne: '打开浏览器菜单', manualTwo: '选择“安装应用”或“添加到主屏幕”',
    close: '关闭安装提示', pending: '正在打开…',
  },
  shell: {
    skip: '跳到正文', homeLabel: 'Very Happy 首页', navLabel: '主导航',
    docs: '文档', signIn: '登录', getStarted: '开始使用', language: '语言', automatic: '自动',
    footerTagline: 'Very Happy · 随处工作，保持上下文', footerLabel: '页脚导航',
    security: '安全', privacy: '隐私', terms: '条款', source: '源码',
  },
  landing: {
    pageTitle: 'Very Happy — 一个面板，连接每台机器与每个 Agent。',
    heroEyebrow: '多机器指挥面板',
    heroTitleA: '一个面板。', heroTitleB: '每台机器。', heroTitleC: '每个 Agent。',
    heroBody: '打开 Web 或 PWA，选择已连接的机器与 Agent，然后派发工作。随时进入正在运行的终端、对话、文件或任务，无需重建上下文。',
    thesisA: '看清全局。', thesisB: '派发工作，随时接管。',
    primaryCta: '连接第一台机器', secondaryCta: '了解工作方式',
    metaWeb: 'Web / PWA 指挥界面', metaChoice: '区域 Relay 自动选路', metaHost: '支持自托管',
    productEyebrow: '真实产品 // 脱敏数据', productTitle: '看清全局，打开工作。',
    productBody: '这就是你真正使用的界面：侧栏集中呈现多台机器的会话，实时终端、结构化 Claude 镜像、文件、预览与任务看板都只需一次点击。',
    webRecommended: 'WEB / PWA · 推荐', webRecommendedBody: '桌面、平板与手机上的日常指挥界面。',
    bridge: 'CLI + DAEMON + TMUX', bridgeBody: '机器侧桥接让普通 xterm-256color 文本 TUI 也能远程访问，而不只支持编程 Agent。',
    agents: 'AGENT 网络 · 已发布 + BETA + 路线图',
    agentsBody: '深度支持 Claude Code · 可用 Codex · Gemini 可通过兼容 ACP stdio 端点从 Web 使用（BETA · 已实现）· OpenCode 通过 CLI ACP beta 使用 · 支持任意文本 TUI。Pi 与 provider gateway 仍在路线图中；当前请明确选择 Web 支持的机器与 Agent。',
    architecture: '架构', matrix: 'Agent 与 MCP 支持矩阵',
    relayEyebrow: '区域 RELAY 平面 // 延迟是路由问题',
    relayTitleA: '控制面保持集中。', relayTitleB: '让终端链路离机器更近。',
    relayBody: 'Daemon 并行探测运营方配置的 Relay，并锚定实测 RTT 最低的健康节点。浏览器使用短期、机器级 token 跟随同一分配，让终端字节和机器 RPC 不再绕行中央数据服务器。',
    relayFactRtt: '实测 RTT · 不靠 GEOIP 猜测', relayFactVisible: '终端显示 RELAY 与延迟',
    relayFactFallback: '旧链路回退 · WEBRTC 下一步', relayLink: '查看数据流',
    startEyebrow: '首次连接 // 三步完成', startTitle: '从身份验证到开始工作。',
    startBody: '验证一次邮箱，连接一台机器，然后从 Web 或已安装的 PWA 开始工作。',
    stepOne: '验证邮箱', stepOneBody: '输入邮箱验证码即可登录；如果是新邮箱且允许注册，系统会自动创建账户。中继启用时，也可使用 Google 或密码登录。',
    stepTwo: '准备机器', stepTwoBody: '需要 Node 20.19+（20.x）、22.13+（22.x）或 24+。配置本地 Agent；推荐使用 tmux 保持终端持久运行。',
    stepThree: '连接并保持在线', stepThreeBody: '然后打开 Web → 新建会话，选择机器与 Agent。',
    quickStart: '查看完整快速开始', deploymentEyebrow: '部署选择',
    deploymentTitle: '使用云端，或掌控自己的基础设施。',
    deploymentBody: '使用 Very Happy Cloud 可以立即开始；如果需要自己的访问策略、存储、备份与运维控制，也可以运行同一套开源服务。',
    cloud: 'Very Happy Cloud', cloudBody: '最快开始 · 容量有限 · 不提供在线率 SLA', cloudLabel: '阅读 Very Happy Cloud 指南',
    selfHosted: '自托管', selfHostedBody: '由你掌控运营方、访问策略、存储与备份', selfHostedLabel: '阅读自托管指南',
    securityDetails: '隐私与安全详情',
    finalEyebrow: '为什么选择 VERY HAPPY // 随处工作', finalTitleA: '界面替你承担繁琐。', finalTitleB: '你只管保持 Very Happy。',
    finalBody: '少巡视一些标签页，少重建一些上下文，把注意力留给只有你能做的判断。', viewSource: '查看源码',
  },
  docs: {
    chaptersLabel: '文档章节', pageTitle: '文档 — Very Happy', notFoundTitle: '未找到 — Very Happy 文档',
    missingEyebrow: '404 // 未找到文档', missingTitle: '这个章节不存在。', missingBody: '文档可能已经移动。', home: '返回文档首页',
    mobileTitle: '文档', toggle: '切换章节', eyebrow: '文档',
    aside: '请根据你的环境选择云端或自托管。', asideLink: '隐私与安全。',
    onThisPage: '本页内容', fieldManual: '现场手册', indexTitleA: '随处开始构建。', indexTitleB: '清晰掌控运行。',
    indexLead: '连接机器、选择 Agent，并通过 Web 或已安装的 PWA 保持系统健康。',
    guides: '篇聚焦指南 · 一个工作区', interfaceEyebrow: '指南中的真实界面', interfaceTitle: '学习你真正会使用的产品。',
    interfaceBody: '下方界面使用已认证 App 的生产组件样式与 Console token，并配合脱敏示例数据。',
    openGuide: '打开指南', fieldGuide: '操作指南', adjacent: '相邻章节', end: '保持上下文。',
    groups: { start: '开始', understand: '理解', operate: '运维', extend: '扩展' },
  },
};

const dictionaries: Partial<Record<SupportedLanguage, PublicCopy>> = { en, 'zh-Hans': zhHans };
let liveLanguage: SupportedLanguage | null = null;
const listeners = new Set<() => void>();

function resolveLanguage(): SupportedLanguage {
  return liveLanguage
    ?? readStoredPreferredLanguage(SUPPORTED_LANGUAGE_CODES)
    ?? resolveLanguageFromTags(browserLanguageTags(), SUPPORTED_LANGUAGE_CODES, 'en');
}

function notify() {
  setDocumentLanguage(resolveLanguage());
  listeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener(LANGUAGE_CHANGE_EVENT, (event) => {
    const language = (event as CustomEvent<string>).detail;
    if (!SUPPORTED_LANGUAGE_CODES.includes(language as SupportedLanguage)) return;
    liveLanguage = language as SupportedLanguage;
    notify();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== 'mmkv:default:settings') return;
    liveLanguage = null;
    notify();
  });
}

export function getPublicLanguage(): SupportedLanguage { return resolveLanguage(); }
export function getPublicCopy(language = resolveLanguage()): PublicCopy { return dictionaries[language] ?? en; }

export function usePublicI18n() {
  const language = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getPublicLanguage,
    getPublicLanguage,
  );
  setDocumentLanguage(language);
  return { language, copy: getPublicCopy(language) };
}
