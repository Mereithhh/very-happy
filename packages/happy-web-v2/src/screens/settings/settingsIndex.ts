/**
 * B-575 — declarative settings index for item-level search (settings sidebar
 * and ⌘K). Pure module: no React, no stores, no CSS, so the command palette
 * can import it without pulling the settings chunk.
 *
 * Every entry's `id` is rendered on the page as `data-setting-id` (Item /
 * ItemGroup `settingId`), and titles/descriptions are the SAME translation
 * keys the page renders — so search text can't drift from the page.
 * settingsIndex.test.tsx renders every section and asserts each anchor exists.
 *
 * Scoring tiers adapted from Orca `components/settings/settings-search.ts`
 * (MIT): title > description > keyword, each exact > prefix > substring.
 * Spec: specs/2026-10-settings-search-and-sidebar-groups.md.
 */
import type { SimpleTranslationKey } from '@/text';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';
import { agentKeys } from '@/sync/agentDefaults';

export type SettingsText = SimpleTranslationKey | { en: string; zh: string };

export interface SettingsIndexEntry {
  /** stable anchor (`data-setting-id`), also the deep-link `?setting=` value */
  id: string;
  /** settings route path ('' = overview), same as SettingsLayout's settingsSections */
  section: string;
  title: SettingsText;
  description?: SettingsText;
  /** zh/en aliases, lower-case */
  keywords: string[];
  /** rendered only where the browser supports Web Push (Notifications page) */
  requires?: 'webPush';
}

/** Section labels — must equal SettingsLayout's settingsSections (tested). */
export const SETTINGS_SECTION_TITLES: Record<string, SettingsText> = {
  '': 'settings.title',
  appearance: 'settings.appearance',
  account: 'settings.account',
  agents: 'settingsAgents.title',
  models: 'modelConfig.title',
  snippets: 'settingsSnippets.navTitle',
  notifications: 'notifications.title',
  channels: 'settingsChannels.title',
  voice: 'settingsVoice.title',
  machines: 'settingsMachines.title',
  shared: 'share.settings.title',
  usage: 'settings.usage',
  diagnostics: 'diagnostics.title',
  password: 'settingsAccount.password',
  email: 'emailAuth.email',
  google: { en: 'Google', zh: 'Google' },
};

const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', openclaw: 'OpenClaw', pi: 'Pi' };

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  // ── appearance ──
  { id: 'appearance.theme', section: 'appearance', title: 'settingsAppearance.theme', description: 'settingsAppearance.themeDescription', keywords: ['theme', 'dark mode', 'light mode', 'dark', 'light', 'night', '主题', '深色', '浅色', '暗色', '夜间', '外观', '配色'] },
  { id: 'appearance.chatTextSize', section: 'appearance', title: 'settingsAppearance.chatTextSize', description: 'settingsAppearance.chatTextSizeDescription', keywords: ['font size', 'text size', 'chat font', 'zoom', 'scale', 'larger text', 'smaller text', '字号', '字体大小', '文字大小', '对话字号', '字大小', '放大', '缩小'] },
  { id: 'appearance.backgroundMotion', section: 'appearance', title: 'settingsAppearance.backgroundMotion', description: 'settingsAppearance.backgroundMotionDescription', keywords: ['background', 'motion', 'animation', 'ascii', 'effects', 'battery', '背景', '动效', '动画', '特效', '省电'] },
  { id: 'appearance.teamsEntry', section: 'appearance', title: { en: 'Show Teams entry', zh: '显示团队入口' }, description: { en: 'Hiding the entry does not stop or delete teams.', zh: '隐藏入口不会停止或删除团队。' }, keywords: ['teams', 'team', 'happy bot', 'bot', '团队', '入口', '侧栏'] },
  { id: 'appearance.homeView', section: 'appearance', title: 'settingsAppearance.homeView', description: 'settingsAppearance.homeViewDescription', keywords: ['home', 'start page', 'board', '首页', '主页', '看板', '默认页面'] },
  { id: 'appearance.closeViewConfirm', section: 'appearance', title: 'settingsAppearance.closeViewConfirm', description: 'settingsAppearance.closeViewConfirmDescription', keywords: ['close', 'cmd+w', '⌘w', 'confirm', '关闭', '确认'] },
  { id: 'appearance.closeTabWarning', section: 'appearance', title: 'settingsAppearance.closeTabWarning', description: 'settingsAppearance.closeTabWarningDescription', keywords: ['close tab', 'leave site', 'beforeunload', '关闭标签', '离开'] },
  { id: 'appearance.boardLlm', section: 'appearance', title: 'settingsAppearance.boardLlm', description: 'settingsAppearance.boardLlmDescription', keywords: ['board', 'llm', 'analysis', 'ai', '看板', '分析'] },
  { id: 'appearance.language', section: 'appearance', title: 'settingsLanguage.title', description: 'settingsLanguage.description', keywords: ['language', 'locale', 'english', 'chinese', 'i18n', '语言', '中文', '英文', '界面语言'] },
  { id: 'appearance.lineNumbers', section: 'appearance', title: 'settingsAppearance.showLineNumbersInDiffs', description: 'settingsAppearance.showLineNumbersInDiffsDescription', keywords: ['line numbers', 'diff', 'gutter', '行号', '代码', '差异'] },
  { id: 'appearance.wrapDiff', section: 'appearance', title: 'settingsAppearance.wrapLinesInDiffs', description: 'settingsAppearance.wrapLinesInDiffsDescription', keywords: ['wrap', 'soft wrap', 'line wrap', 'diff', '换行', '自动换行', '折行', '差异'] },
  { id: 'appearance.featureTips', section: 'appearance', title: 'featureTips.resetTitle', description: 'featureTips.resetDescription', keywords: ['tips', 'hints', 'onboarding', 'reset', 'feature', '提示', '功能提示', '引导', '重置', '新功能'] },
  // ── account ──
  { id: 'account.profile', section: 'account', title: 'settingsProfile.title', description: 'settingsProfile.subtitle', keywords: ['profile', 'name', 'handle', 'username', 'display name', '资料', '昵称', '名字', '用户名', '句柄'] },
  { id: 'account.emailLogin', section: 'account', title: 'settingsAccount.emailLogin', keywords: ['email', 'mail', 'login', '邮箱', '邮件', '登录'] },
  { id: 'account.googleLogin', section: 'account', title: 'settingsAccount.googleLogin', keywords: ['google', 'oauth', 'login', '谷歌', '登录'] },
  { id: 'account.password', section: 'account', title: 'settingsAccount.password', keywords: ['password', 'change password', '密码', '修改密码'] },
  { id: 'account.server', section: 'account', title: 'settingsAccount.server', keywords: ['server', 'host', 'url', '服务器', '地址'] },
  { id: 'account.logout', section: 'account', title: 'settingsAccount.logout', description: 'settingsAccount.logoutSubtitle', keywords: ['logout', 'log out', 'sign out', '退出', '登出', '注销'] },
  // ── agents ──
  { id: 'agents.defaultAgent', section: 'agents', title: 'settingsAgents.defaultAgent', keywords: ['agent', 'default agent', 'claude', 'codex', 'pi', 'new chat', '默认', '新建', '代理'] },
  { id: 'agents.alwaysAsk', section: 'agents', title: 'settingsAgents.alwaysAsk', description: 'settingsAgents.alwaysAskDescription', keywords: ['ask', 'new session', 'dialog', 'configure', '询问', '新建', '每次', '弹窗'] },
  { id: 'agents.reviewFirst', section: 'agents', title: 'settingsFeatures.reviewChangesFirst', keywords: ['review', 'changes', 'diff', '审阅', '改动', '先看'] },
  ...agentKeys.map((agent): SettingsIndexEntry => {
    const name = AGENT_NAMES[agent] ?? agent;
    return {
      id: `agents.${agent}`,
      section: 'agents',
      // = the group's visible title (agent name); results read "Agent defaults › Claude"
      title: { en: name, zh: name },
      description: { en: 'Default permission, model and effort for new sessions', zh: '新会话的默认权限、模型与思考强度' },
      keywords: [agent, 'permission', 'model', 'effort', 'thinking', 'yolo', '权限', '模型', '思考强度', '默认'],
    };
  }),
  // ── snippets ──
  { id: 'snippets.presets', section: 'snippets', title: 'settingsSnippets.presetsGroup', description: 'settingsSnippets.presetsFooter', keywords: ['snippet', 'shortcut', 'preset', 'prompt', 'quick command', '快捷指令', '快捷短语', '预设', '片段'] },
  { id: 'snippets.startup', section: 'snippets', title: 'settingsSnippets.startupGroup', description: 'settingsSnippets.startupFooter', keywords: ['startup', 'terminal', 'command', 'init', '启动', '启动命令', '终端'] },
  { id: 'snippets.inputOwnership', section: 'snippets', title: 'settingsSnippets.inputOwnershipGroup', description: 'settingsSnippets.inputOwnershipFooter', keywords: ['input', 'keyboard', 'terminal', '输入', '键盘', '终端'] },
  { id: 'snippets.viewDefault', section: 'snippets', title: 'settingsSnippets.viewDefaultGroup', description: 'settingsSnippets.viewDefaultFooter', keywords: ['xterm', 'structured', 'terminal view', '终端视图', '默认视图', '结构化'] },
  // ── notifications (r3-push owns this section's structure; anchors are on groups only) ──
  { id: 'notifications.browser', section: 'notifications', requires: 'webPush', title: 'notifications.browserNotifications', description: 'notifications.masterDescription', keywords: ['push', 'notification', 'browser', 'web push', 'alert', '通知', '推送', '浏览器通知', '系统通知'] },
  { id: 'notifications.types', section: 'notifications', requires: 'webPush', title: 'notifications.types', description: 'notifications.typesDescription', keywords: ['notification types', 'permission', 'done', 'error', 'input', '通知类型', '授权', '完成', '错误'] },
  { id: 'notifications.quietHours', section: 'notifications', requires: 'webPush', title: 'notifications.quietHours', description: 'notifications.quietHoursDescription', keywords: ['quiet hours', 'quiet', 'dnd', 'do not disturb', 'mute', 'night', '免打扰', '勿扰', '静音', '安静时段'] },
  { id: 'notifications.sound', section: 'notifications', title: 'notifications.sound', description: 'notifications.soundDescription', keywords: ['sound', 'chime', 'audio', 'volume', 'beep', 'mute', '提示音', '声音', '音量', '响铃', '静音'] },
  { id: 'notifications.soundVoice', section: 'notifications', title: 'notifications.soundVoice', description: 'notifications.soundVoiceDescription', keywords: ['sound', 'chime', 'tone', 'ding', '提示音', '音色'] },
  { id: 'notifications.soundPacks', section: 'notifications', title: 'notifications.soundPacks', description: 'notifications.soundPacksDescription', keywords: ['sound pack', 'voice pack', 'peon', 'red alert', 'openpeon', '语音包', '音效包', '提示音'] },
  { id: 'notifications.soundEvents', section: 'notifications', title: 'notifications.soundEvents', description: 'notifications.soundEventsDescription', keywords: ['sound', 'events', 'when to play', '提示音', '事件'] },
  { id: 'notifications.inbox', section: 'notifications', title: 'notifications.inboxGroup', description: 'notifications.inboxRetentionDescription', keywords: ['inbox', 'retention', 'bell', 'history', 'notification center', '通知中心', '保留', '铃铛', '历史'] },
  // ── channels ──
  { id: 'channels.webhook', section: 'channels', title: 'notifications.webhook', description: 'notifications.webhookDescription', keywords: ['webhook', 'http', 'callback', 'integration', 'slack', 'feishu', '回调', '推送', '群', '集成'] },
  { id: 'channels.cli', section: 'channels', title: 'settingsChannels.cliTitle', keywords: ['cli', 'spawn', 'send', 'command line', 'script', '命令行', '脚本'] },
  { id: 'channels.mcp', section: 'channels', title: 'settingsChannels.mcpTitle', keywords: ['mcp', 'clipboard', 'tool', '剪贴板', '工具'] },
  { id: 'channels.clipboardAutoCopy', section: 'channels', title: 'clipboard.autoCopyTitle', description: 'clipboard.autoCopySubtitle', keywords: ['clipboard', 'copy', 'auto copy', '剪贴板', '复制', '自动复制'] },
  { id: 'channels.clipboardHistory', section: 'channels', title: 'clipboard.historyTitle', description: 'clipboard.historyOpenSubtitle', keywords: ['clipboard', 'history', '剪贴板', '历史'] },
  { id: 'channels.filePreview', section: 'channels', title: 'filePreview.receiveTitle', description: 'filePreview.receiveSubtitle', keywords: ['preview', 'open_preview', 'file', '预览', '文件'] },
  { id: 'channels.im', section: 'channels', title: 'settingsChannels.imTitle', keywords: ['im', 'chat', 'telegram', 'tanka', 'bot', '即时通讯', '聊天', '机器人'] },
  // ── voice ──
  { id: 'voice.voice', section: 'voice', title: 'settingsVoice.voice', keywords: ['voice', 'tts', 'speaker', 'elevenlabs', '语音', '音色', '朗读'] },
  { id: 'voice.library', section: 'voice', title: 'settingsVoice.library', keywords: ['voice library', 'voices', '语音库', '音色库'] },
  { id: 'voice.asrLanguage', section: 'voice', title: 'settingsVoice.asrLanguage', description: 'settingsVoice.asrLanguageHint', keywords: ['asr', 'speech recognition', 'dictation', 'language', '语音识别', '听写', '语言'] },
  { id: 'voice.readTextReplies', section: 'voice', title: 'settingsVoice.readTextReplies', description: 'settingsVoice.readTextRepliesHint', keywords: ['read aloud', 'tts', 'speak', '朗读', '读出'] },
  { id: 'voice.pttSound', section: 'voice', title: 'settingsVoice.pttSound', description: 'settingsVoice.pttSoundHint', keywords: ['push to talk', 'ptt', 'sound', '按住说话', '提示音'] },
  { id: 'voice.skipPermissions', section: 'voice', title: 'settingsVoice.skipPermissions', description: 'settingsVoice.skipPermissionsHint', keywords: ['permission', 'yolo', 'skip', '权限', '跳过'] },
  { id: 'voice.assistantMachine', section: 'voice', title: 'settingsVoice.assistantMachine', keywords: ['machine', 'assistant', 'computer', '电脑', '机器', '助手'] },
  // ── shared (B-701) ──
  { id: 'shared.list', section: 'shared', title: 'share.settings.title', description: 'share.settings.subtitle', keywords: ['share', 'shared', 'link', 'revoke', 'expire', 'access', '分享', '链接', '撤销', '过期', '已分享', '联系人'] },
  // ── machines ──
  // ── models (B-688) ──
  { id: 'models.machine', section: 'models', title: 'modelConfig.machine', description: 'modelConfig.subtitle', keywords: ['model', 'provider', 'base url', 'baseurl', 'api key', 'gateway', 'custom model', 'claude', 'codex', 'gemini', 'pi', 'anthropic_base_url', 'config.toml', 'settings.json', '模型', '自定义模型', '网关', '密钥', '供应商'] },
  { id: 'machines.connect', section: 'machines', title: 'connectMachine.groupTitle', keywords: ['connect', 'add machine', 'install', 'pair', '连接', '添加电脑', '配对', '安装'] },
  { id: 'machines.list', section: 'machines', title: 'settingsMachines.listTitle', description: 'settingsMachines.footer', keywords: ['machines', 'computers', 'daemon', '电脑', '机器'] },
  // ── diagnostics ──
  { id: 'diagnostics.webBuild', section: 'diagnostics', title: 'diagnostics.webBuild', keywords: ['version', 'build', 'update', 'reload', '版本', '构建', '更新'] },
  { id: 'diagnostics.relay', section: 'diagnostics', title: 'diagnostics.relay', keywords: ['relay', 'socket', 'connection', 'offline', '中继', '连接', '断线'] },
  { id: 'diagnostics.machines', section: 'diagnostics', title: 'diagnostics.machinesAndDaemons', keywords: ['daemon', 'cli', 'machine', 'version', '守护进程', '电脑', '版本'] },
  { id: 'diagnostics.verboseLogging', section: 'diagnostics', title: 'diagnostics.verboseLogging', description: 'diagnostics.verboseLoggingDescription', keywords: ['debug', 'log', 'verbose', '日志', '调试'] },
  { id: 'diagnostics.consoleLogging', section: 'diagnostics', title: 'diagnostics.consoleLogging', description: 'diagnostics.consoleLoggingDescription', keywords: ['console', 'log', 'devtools', '控制台', '日志'] },
  { id: 'diagnostics.safeAreaDiag', section: 'diagnostics', title: 'diagnostics.safeAreaDiag', description: 'diagnostics.safeAreaDiagDescription', keywords: ['safe area', 'inset', 'status bar', 'iphone duo', 'fold', '安全区', '状态栏', '折叠', '遮挡'] },
  { id: 'diagnostics.viewportDiag', section: 'diagnostics', title: 'diagnostics.viewportDiag', description: 'diagnostics.viewportDiagDescription', keywords: ['viewport', 'safe area', 'pwa', 'iphone', '视口', '留白', '白条', '安全区'] },
];

// ---------------------------------------------------------------------------

/** Plain-string lookup of a dot key in one translation dictionary. */
export function lookupText(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Both language variants of a text — the haystack covers zh and en
 *  regardless of the UI language (typing "sound" in a zh UI still works). */
export function textVariants(text: SettingsText): { en: string; zh: string } {
  if (typeof text !== 'string') return text;
  const enText = lookupText(en, text) ?? text;
  return { en: enText, zh: lookupText(zhHans, text) ?? enText };
}

/** Display text in the current UI language (`translate` = the live t()). */
export function displayText(text: SettingsText, lang: string, translate: (key: SimpleTranslationKey) => string): string {
  if (typeof text === 'string') return translate(text);
  return lang.startsWith('zh') ? text.zh : text.en;
}

export function sectionTitle(section: string): SettingsText {
  return SETTINGS_SECTION_TITLES[section] ?? { en: section, zh: section };
}

/** `/settings/<section>?setting=<id>` — the one deep-link shape (sidebar results, ⌘K). */
export function settingHref(entry: Pick<SettingsIndexEntry, 'id' | 'section'>, basePath = '/settings'): string {
  return `${basePath}${entry.section ? `/${entry.section}` : ''}?setting=${encodeURIComponent(entry.id)}`;
}

export const SETTING_QUERY_PARAM = 'setting';

type Tier = readonly [exact: number, prefix: number, substring: number];
const TITLE: Tier = [700, 650, 600];
const DESCRIPTION: Tier = [500, 450, 400];
const KEYWORD: Tier = [300, 250, 200];
const SECTION: Tier = [150, 140, 130];

function scoreText(term: string, value: string | undefined, tier: Tier): number {
  if (!value) return 0;
  const v = value.toLowerCase();
  if (v === term) return tier[0];
  if (v.startsWith(term)) return tier[1];
  return v.includes(term) ? tier[2] : 0;
}

export function normalizeSettingsQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export interface SettingsSearchOptions {
  /** where Web Push is unsupported, `requires:'webPush'` entries are not on the page */
  webPush: boolean;
}

export interface SettingsSearchHit {
  entry: SettingsIndexEntry;
  score: number;
}

/**
 * Rank entries for a free-text query. Every whitespace-separated term must hit
 * somewhere (AND); an entry's score is the sum of each term's best tier.
 * Ties keep index order (stable). Empty query → [].
 */
export function searchSettings(
  query: string,
  opts: SettingsSearchOptions,
  entries: readonly SettingsIndexEntry[] = SETTINGS_INDEX,
): SettingsSearchHit[] {
  const terms = normalizeSettingsQuery(query);
  if (terms.length === 0) return [];
  const hits: (SettingsSearchHit & { index: number })[] = [];
  entries.forEach((entry, index) => {
    if (entry.requires === 'webPush' && !opts.webPush) return;
    const title = textVariants(entry.title);
    const desc = entry.description ? textVariants(entry.description) : undefined;
    const sec = textVariants(sectionTitle(entry.section));
    let total = 0;
    // A section name alone ("通知") must not list the whole section — that is
    // what the category results are for. It only narrows a query that also
    // hits the entry itself ("通知 声音").
    let ownHit = false;
    for (const term of terms) {
      const own = Math.max(
        scoreText(term, title.en, TITLE),
        scoreText(term, title.zh, TITLE),
        scoreText(term, desc?.en, DESCRIPTION),
        scoreText(term, desc?.zh, DESCRIPTION),
        ...entry.keywords.map((k) => scoreText(term, k, KEYWORD)),
      );
      const best = Math.max(own, scoreText(term, sec.en, SECTION), scoreText(term, sec.zh, SECTION));
      if (best === 0) return;
      if (own > 0) ownHit = true;
      total += best;
    }
    if (!ownHit) return;
    hits.push({ entry, score: total, index });
  });
  return hits
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry, score }) => ({ entry, score }));
}

export function findSettingEntry(id: string | null | undefined): SettingsIndexEntry | undefined {
  return id ? SETTINGS_INDEX.find((e) => e.id === id) : undefined;
}
