/**
 * Main agent (B-916a) UI copy — zh / en, the issuesCopy / projectMenuCopy
 * pattern (a new surface ships two languages; the rest fall back to en).
 */

export interface MainAgentCopy {
    title: string;
    entryHint: string;
    statusIdle: string;
    statusThinking: string;
    statusOffline: string;
    statusAttention: string;
    statusNone: string;
    close: string;
    back: string;
    openSession: string;
    openSettings: string;
    newConversation: string;
    newConversationConfirm: string;
    placeholder: string;
    send: string;
    empty: string;
    offlineBanner: (machine: string) => string;
    permissionBanner: string;
    permissionOpen: string;
    enableTitle: string;
    enableBody: string;
    enableMachine: string;
    recommended: string;
    enable: string;
    enabling: string;
    noMachine: string;
    connectMachine: string;
    upgradeTitle: string;
    upgradeBody: (machine: string, version: string) => string;
    upgradeOpenMachine: string;
    starting: (machine: string) => string;
    startFailed: string;
    retry: string;
    unknownVersion: string;
    otherMachine: string;
    gatesMissing: string;
    gatesActive: string;
    invalidLines: (lines: string) => string;
    tooMany: (max: number) => string;
    paletteAsk: (q: string) => string;
    paletteOpen: string;
    // settings
    settingsTitle: string;
    settingsSubtitle: string;
    settingsMachine: string;
    settingsMachineHint: string;
    voiceMachineMoved: string;
    settingsMachineNone: string;
    settingsMove: string;
    settingsMoveConfirm: (machine: string) => string;
    settingsSkillRoots: string;
    settingsSkillRootsHint: string;
    settingsDenied: string;
    settingsDeniedHint: string;
    settingsSave: string;
    settingsSaved: string;
    settingsSaveFailed: string;
    settingsLoadFailed: string;
    settingsStoredIn: string;
    offlineSuffix: string;
}

const zh: MainAgentCopy = {
    title: '主 agent',
    entryHint: '问主 agent（⌘K 里输入后选「问主 agent」）',
    statusIdle: '空闲',
    statusThinking: '在想',
    statusOffline: '离线',
    statusAttention: '等你处理',
    statusNone: '未启用',
    close: '关闭',
    back: '返回',
    openSession: '在会话页打开',
    openSettings: '主 agent 设置',
    newConversation: '新对话',
    newConversationConfirm: '开一个新对话？旧对话会归档，记忆文件保留。',
    placeholder: '问主 agent…',
    send: '发送',
    empty: '什么都可以问：派活、查进度、建自动化、整理 todo。',
    offlineBanner: (m) => `${m} 离线：消息已保存，机器上线后处理。`,
    permissionBanner: '主 agent 在等你批准一个操作。',
    permissionOpen: '去批准',
    enableTitle: '还没有主 agent',
    enableBody: '主 agent 是整个账号唯一的一个常驻会话，跑在一台机器上。选一台常在线的机器启用。',
    enableMachine: '运行在',
    recommended: '推荐',
    enable: '启用',
    enabling: '启用中…',
    noMachine: '没有在线、且 CLI 版本够新的机器。',
    connectMachine: '连接机器',
    upgradeTitle: '这台机器的 CLI 需要升级',
    upgradeBody: (m, v) => `${m} 上的 CLI 是 ${v}，还不支持主 agent（需要带安全闸的新版 CLI）。升级后再打开。`,
    upgradeOpenMachine: '打开机器页',
    starting: (m) => `正在 ${m} 上启动主 agent…`,
    startFailed: '启动失败',
    retry: '重试',
    unknownVersion: '未知版本',
    otherMachine: '主 agent 在另一台机器上。要换机器，去设置里改。',
    gatesMissing: '所在机器的 CLI 还没有主 agent 安全闸（出站禁用），升级 CLI 后生效。',
    gatesActive: '安全闸已在当前主 agent 会话里生效。',
    invalidLines: (l) => `格式不对，未保存：${l}`,
    tooMany: (n) => `最多 ${n} 项。`,
    paletteAsk: (q) => `问主 agent：${q}`,
    paletteOpen: '打开主 agent',
    settingsTitle: '主 agent',
    settingsSubtitle: '运行机器、skills 目录、出站禁用表',
    settingsMachine: '运行在哪台机器',
    settingsMachineHint: '全账号只有一个主 agent。换机器会在新机器上开新对话，旧对话归档。',
    voiceMachineMoved: '主 agent 已启用：运行机器在「主 agent」设置里改。',
    settingsMachineNone: '未启用',
    settingsMove: '换到这台',
    settingsMoveConfirm: (m) => `把主 agent 换到 ${m}？会在那台机器上开新对话。`,
    settingsSkillRoots: 'skills 目录（skillRoots）',
    settingsSkillRootsHint: '每行一个运行机器上的绝对路径或 ~ 开头的路径，最多 16 项。主 agent 启动时挂载这些目录里的 skills。',
    settingsDenied: '出站禁用表（补充项）',
    settingsDeniedHint: '每行一个工具名或通配模式（只用字母、数字、_ . - 和 *），例如 mcp__*__*archive*，最多 64 项。只能在内置禁用表之上加严，不能放开。',
    settingsSave: '保存',
    settingsSaved: '已保存',
    settingsSaveFailed: '保存失败，稍后重试',
    settingsLoadFailed: '读取失败',
    settingsStoredIn: '保存在账号配置里，主 agent 下次启动时生效。',
    offlineSuffix: '离线',
};

const en: MainAgentCopy = {
    title: 'Main agent',
    entryHint: 'Ask the main agent (type in ⌘K, then pick “Ask main agent”)',
    statusIdle: 'Idle',
    statusThinking: 'Thinking',
    statusOffline: 'Offline',
    statusAttention: 'Needs you',
    statusNone: 'Not set up',
    close: 'Close',
    back: 'Back',
    openSession: 'Open as session',
    openSettings: 'Main agent settings',
    newConversation: 'New conversation',
    newConversationConfirm: 'Start a new conversation? The old one is archived; memory files are kept.',
    placeholder: 'Ask the main agent…',
    send: 'Send',
    empty: 'Ask anything: hand off work, check progress, set up automations, sort todos.',
    offlineBanner: (m) => `${m} is offline. Your message is saved and handled when it reconnects.`,
    permissionBanner: 'The main agent is waiting for you to approve an action.',
    permissionOpen: 'Review',
    enableTitle: 'No main agent yet',
    enableBody: 'The main agent is the one always-on session for your whole account, running on one machine. Pick a machine that stays online.',
    enableMachine: 'Run on',
    recommended: 'Recommended',
    enable: 'Enable',
    enabling: 'Enabling…',
    noMachine: 'No machine is online with a recent enough CLI.',
    connectMachine: 'Connect a machine',
    upgradeTitle: 'This machine’s CLI needs an update',
    upgradeBody: (m, v) => `${m} runs CLI ${v}, which has no main agent yet (it needs a CLI with the safety gates). Update it, then come back.`,
    upgradeOpenMachine: 'Open machine',
    starting: (m) => `Starting the main agent on ${m}…`,
    startFailed: 'Could not start',
    retry: 'Retry',
    unknownVersion: 'an unknown version',
    otherMachine: 'The main agent runs on another machine. Change it in settings.',
    gatesMissing: 'The CLI on its machine has no main agent gates (outbound deny list) yet; update the CLI to turn them on.',
    gatesActive: 'The gates are active in the current main agent session.',
    invalidLines: (l) => `Not saved, invalid format: ${l}`,
    tooMany: (n) => `At most ${n} entries.`,
    paletteAsk: (q) => `Ask main agent: ${q}`,
    paletteOpen: 'Open main agent',
    settingsTitle: 'Main agent',
    settingsSubtitle: 'Machine, skills folders, outbound deny list',
    settingsMachine: 'Runs on',
    settingsMachineHint: 'Your account has one main agent. Moving it starts a new conversation on the new machine and archives the old one.',
    voiceMachineMoved: 'The main agent is on: change its machine in Main agent settings.',
    settingsMachineNone: 'Not set up',
    settingsMove: 'Move here',
    settingsMoveConfirm: (m) => `Move the main agent to ${m}? A new conversation starts there.`,
    settingsSkillRoots: 'Skills folders (skillRoots)',
    settingsSkillRootsHint: 'One path per line on the host machine (absolute or starting with ~), up to 16. Skills in these folders are mounted when the main agent starts.',
    settingsDenied: 'Outbound deny list (additions)',
    settingsDeniedHint: 'One tool name or wildcard per line (letters, digits, _ . - and * only), e.g. mcp__*__*archive*, up to 64. Adds to the built-in deny list; it can never allow more.',
    settingsSave: 'Save',
    settingsSaved: 'Saved',
    settingsSaveFailed: 'Could not save. Try again later.',
    settingsLoadFailed: 'Could not load',
    settingsStoredIn: 'Stored in your account; applies the next time the main agent starts.',
    offlineSuffix: 'offline',
};

export function mainAgentCopy(lang: string): MainAgentCopy {
    return lang.startsWith('zh') ? zh : en;
}
