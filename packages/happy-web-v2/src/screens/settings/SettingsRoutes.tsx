import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import * as Switch from '@radix-ui/react-switch';
import {
  ChevronLeft,
  ChevronRight,
  User,
  Palette,
  Bot,
  Bookmark,
  Bell,
  Volume2,
  BarChart3,
  Stethoscope,
  LogOut,
  Check,
  Plus,
  Trash2,
  Github,
  Server as ServerIcon,
  Cable,
  ExternalLink,
  BookOpen,
  ClipboardList,
} from 'lucide-react';
import {
  ItemList,
  ItemGroup,
  Item,
  Button,
  Input,
  Spinner,
  Badge,
  StatusDot,
  useToast,
} from '@/ui';
import { useTheme } from '@/ui';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { checkForUpdateNow } from '@/app/staleBundleReload';
import { useTranslation, type SupportedLanguage } from '@/i18n/useTranslation';
import type { SimpleTranslationKey } from '@/text';
import { SUPPORTED_LANGUAGES } from '@/text/_all';
import {
  useSettingMutable,
  useLocalSettingMutable,
  useProfile,
  useAllMachines,
  useSocketStatus,
} from '@/sync/storage';
import { sync } from '@/sync/sync';
import {
  agentKeys,
  normalizeAgentKey,
  type AgentKey,
  type AgentDefaultField,
  resolveAgentDefaultConfig,
  getAgentDefaultOverrideValue,
  setAgentDefaultOverride,
} from '@/sync/agentDefaults';
import {
  getHardcodedPermissionModes,
  getHardcodedModelModes,
  getEffortLevelsForModel,
  type ModeOption,
} from '@/components/modelModeOptions';
import { setAccountCredentials, AccountAuthError } from '@/auth/passwordUnlock';
import { disconnectGitHub } from '@/sync/apiGithub';
import { disconnectService } from '@/sync/apiServices';
import { getDisplayName, getAvatarUrl } from '@/sync/profile';
import {
  isWebPushSupported,
  enableWebPush,
  disableWebPush,
} from '@/sync/webPush';
import {
  useNotificationPrefs,
  setNotificationPrefs,
  setTypeEnabled,
  setQuietHours,
  formatMinute,
} from '@/sync/notificationPrefs';
import { getNotificationPermission, requestNotificationPermission } from '@/sync/webNotifications';
import {
  useSoundPrefs,
  updateSoundPrefs,
  setSoundEventEnabled,
  getSoundPrefs,
} from '@/sync/soundPrefs';
import { playChime, CHIME_VOICES, type ChimeVoice } from '@/utils/chimes';
import {
  useRetentionDays,
  setRetentionDays,
  RETENTION_DAY_OPTIONS,
} from '@/sync/localNotificationStore';
import type { SoundEvent } from '@/sync/notificationInbox';
import { setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { fetchWebhookConfig, saveWebhookConfig, deleteWebhookConfig, type WebhookEvent } from '@/sync/apiWebhook';
import type { NotifType } from '@/sync/feedTypes';
import { getUsageForPeriod, calculateTotals, type UsageDataPoint } from '@/sync/apiUsage';
import { getServerInfo } from '@/sync/serverConfig';
import { openClipboardHistory } from '@/screens/clipboard/ClipboardHistoryPanel';
import { VoiceSettings } from './VoiceSettings';
import { CodeView } from '@/screens/session/CodeView';
import './settings.css';

const MIN_PASSWORD = 8;

// ----- shared layout shells -----

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="set-scroll" style={{ height: '100dvh' }}>
      <div className="set-page">{children}</div>
    </div>
  );
}

function Header({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <div className="set-header">
      {onBack && (
        <button type="button" className="set-header__back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
      )}
      <div className="set-header__titles">
        <span className="set-header__title">{title}</span>
        {subtitle && <span className="set-header__subtitle">{subtitle}</span>}
      </div>
      {right && <div className="set-header__right">{right}</div>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch.Root
      className="set-switch"
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
    >
      <Switch.Thumb className="set-switch__thumb" />
    </Switch.Root>
  );
}

// ===================================================================
// Overview
// ===================================================================

function Overview() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { t } = useTranslation();

  async function onLogout() {
    const ok = await Modal.confirm(
      t('settingsAccount.logout'),
      t('settingsAccount.logoutConfirm'),
      { confirmText: t('common.logout'), destructive: true },
    );
    if (ok) await logout();
  }

  return (
    <Page>
      <Header title={t('settings.title')} onBack={() => navigate('/')} />
      <ItemList>
        <ItemGroup>
          <Item
            title={t('settings.account')}
            subtitle={t('settings.accountSubtitle')}
            left={<User size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/account')}
          />
          <Item
            title={t('settings.appearance')}
            subtitle={t('settings.appearanceSubtitle')}
            left={<Palette size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/appearance')}
          />
          <Item
            title={t('settingsAgents.title')}
            subtitle={t('settingsAgents.subtitle')}
            left={<Bot size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/agents')}
          />
          <Item
            title={t('settingsSnippets.navTitle')}
            subtitle={t('settingsSnippets.navSubtitle')}
            left={<Bookmark size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/snippets')}
          />
          <Item
            title={t('notifications.title')}
            subtitle={t('notifications.settingsSubtitle')}
            left={<Bell size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/notifications')}
          />
          <Item
            title={t('settingsChannels.title')}
            subtitle={t('settingsChannels.subtitle')}
            left={<Cable size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/channels')}
          />
          <Item
            title={t('settingsVoice.title')}
            subtitle={t('settingsVoice.subtitle')}
            left={<Volume2 size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/voice')}
          />
          <Item
            title={t('settings.usage')}
            subtitle={t('settings.usageSubtitle')}
            left={<BarChart3 size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/usage')}
          />
          <Item
            title={t('diagnostics.title')}
            subtitle={t('diagnostics.subtitle')}
            left={<Stethoscope size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/diagnostics')}
          />
        </ItemGroup>

        <ItemGroup title={t('settingsAccount.dangerZone')}>
          <Item
            title={t('settingsAccount.logout')}
            subtitle={t('settingsAccount.logoutSubtitle')}
            left={<LogOut size={18} />}
            destructive
            onClick={onLogout}
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Appearance
// ===================================================================

function Appearance() {
  const navigate = useNavigate();
  const { t, lang, setLanguage } = useTranslation();
  const { preference, setPreference } = useTheme();
  // NOTE: wired to `showLineNumbersInToolViews` — the key ToolView actually
  // reads. (The legacy `showLineNumbers` schema key has no web consumer.)
  const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbersInToolViews');
  // Consumed by DiffView on coarse-pointer (touch) devices only — desktop
  // diffs always use horizontal scroll (see DiffView for why).
  const [wrapDiffLines, setWrapDiffLines] = useSettingMutable('wrapLinesInDiffs');
  const [, setPreferredLanguage] = useSettingMutable('preferredLanguage');
  // device-local: what `/` shows when nothing is open (empty detail vs board)
  const [homeView, setHomeView] = useLocalSettingMutable('homeView');

  const themeOpts: { key: 'system' | 'dark' | 'light'; label: string; desc: string }[] = [
    {
      key: 'system',
      label: t('settingsAppearance.themeOptions.adaptive'),
      desc: t('settingsAppearance.themeDescriptions.adaptive'),
    },
    {
      key: 'light',
      label: t('settingsAppearance.themeOptions.light'),
      desc: t('settingsAppearance.themeDescriptions.light'),
    },
    {
      key: 'dark',
      label: t('settingsAppearance.themeOptions.dark'),
      desc: t('settingsAppearance.themeDescriptions.dark'),
    },
  ];

  const langCodes = Object.keys(SUPPORTED_LANGUAGES) as SupportedLanguage[];

  function pickLanguage(code: SupportedLanguage | null) {
    // Persist the synced preference AND flip the live in-memory language so the
    // UI updates instantly — no app restart needed on web.
    setPreferredLanguage(code);
    if (code) setLanguage(code);
  }

  return (
    <Page>
      <Header
        title={t('settings.appearance')}
        subtitle={t('settings.appearanceSubtitle')}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup
          title={t('settingsAppearance.theme')}
          footer={t('settingsAppearance.themeDescription')}
        >
          {themeOpts.map((o) => (
            <Item
              key={o.key}
              title={o.label}
              subtitle={o.desc}
              selected={preference === o.key}
              right={preference === o.key ? <Check size={16} /> : undefined}
              onClick={() => setPreference(o.key)}
            />
          ))}
        </ItemGroup>

        <ItemGroup
          title={t('settingsAppearance.homeView')}
          footer={t('settingsAppearance.homeViewDescription')}
        >
          {(['normal', 'board'] as const).map((v) => (
            <Item
              key={v}
              title={t(`settingsAppearance.homeViewOptions.${v}`)}
              subtitle={t(`settingsAppearance.homeViewDescriptions.${v}`)}
              selected={homeView === v}
              right={homeView === v ? <Check size={16} /> : undefined}
              onClick={() => setHomeView(v)}
            />
          ))}
        </ItemGroup>

        {/* Task Board V2 — LLM analysis is a DAEMON-side opt-in; the synced
            settings blob is client-side encrypted and the CLI can't read it,
            so there is deliberately no toggle here — only the pointer. */}
        <ItemGroup
          title={t('settingsAppearance.boardLlm')}
          footer={t('settingsAppearance.boardLlmDescription')}
        >
          <Item
            title={t('settingsAppearance.boardLlmHowTo')}
            subtitle={t('settingsAppearance.boardLlmHowToDetail')}
          />
        </ItemGroup>

        <ItemGroup
          title={t('settingsLanguage.title')}
          footer={t('settingsLanguage.description')}
        >
          <Item
            title={t('settingsLanguage.automatic')}
            subtitle={t('settingsLanguage.automaticSubtitle')}
            onClick={() => pickLanguage(null)}
          />
          {langCodes.map((code) => (
            <Item
              key={code}
              title={SUPPORTED_LANGUAGES[code].nativeName}
              subtitle={SUPPORTED_LANGUAGES[code].englishName}
              detail={code}
              selected={lang === code}
              right={lang === code ? <Check size={16} /> : undefined}
              onClick={() => pickLanguage(code)}
            />
          ))}
        </ItemGroup>

        <ItemGroup
          title={t('settingsAppearance.display')}
          footer={t('settingsAppearance.displayDescription')}
        >
          <Item
            title={t('settingsAppearance.showLineNumbersInDiffs')}
            subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription')}
            right={
              <Toggle
                checked={showLineNumbers}
                onChange={setShowLineNumbers}
                label={t('settingsAppearance.showLineNumbersInDiffs')}
              />
            }
          />
          <Item
            title={t('settingsAppearance.wrapLinesInDiffs')}
            subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
            right={
              <Toggle
                checked={wrapDiffLines}
                onChange={setWrapDiffLines}
                label={t('settingsAppearance.wrapLinesInDiffs')}
              />
            }
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Account
// ===================================================================

function Account() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { logout, credentials } = useAuth();
  const toast = useToast();
  const profile = useProfile();

  const displayName = getDisplayName(profile);
  const avatarUrl = getAvatarUrl(profile);
  const serverInfo = getServerInfo();

  async function onDisconnectGithub() {
    if (!credentials) return;
    const ok = await Modal.confirm(
      t('modals.disconnectGithub'),
      t('modals.disconnectGithubConfirm'),
      { confirmText: t('modals.disconnect'), destructive: true },
    );
    if (!ok) return;
    try {
      await disconnectGitHub(credentials);
      await sync.refreshProfile();
      toast.success(t('common.success'));
    } catch {
      toast.error(t('common.error'));
    }
  }

  async function onDisconnectService(service: string) {
    if (!credentials) return;
    const ok = await Modal.confirm(
      t('modals.disconnectService', { service }),
      t('modals.disconnectServiceConfirm', { service }),
      { confirmText: t('modals.disconnect'), destructive: true },
    );
    if (!ok) return;
    try {
      await disconnectService(credentials, service);
      await sync.refreshProfile();
      toast.success(t('common.success'));
    } catch {
      toast.error(t('common.error'));
    }
  }

  async function onLogout() {
    const ok = await Modal.confirm(
      t('settingsAccount.logout'),
      t('settingsAccount.logoutConfirm'),
      { confirmText: t('common.logout'), destructive: true },
    );
    if (ok) await logout();
  }

  const otherServices = (profile.connectedServices ?? []).filter((s) => s !== 'github');

  return (
    <Page>
      <Header
        title={t('settings.account')}
        subtitle={t('settings.accountSubtitle')}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup title={t('settingsAccount.accountInformation')}>
          <Item
            title={t('settingsAccount.status')}
            right={
              <Badge tone={credentials ? 'live' : 'muted'}>
                {credentials ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
              </Badge>
            }
          />
          {profile.id && (
            <Item title={t('settingsAccount.publicId')} detail={profile.id} />
          )}
          <Item
            title={t('settingsAccount.password')}
            subtitle={t('settingsAccount.passwordChange')}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/password')}
          />
          <Item title={t('settingsAccount.server')} detail={serverInfo.hostname} />
        </ItemGroup>

        {(profile.github || displayName || avatarUrl) && (
          <ItemGroup title={t('settingsAccount.profile')}>
            {displayName && <Item title={t('settingsAccount.name')} subtitle={displayName} />}
            {profile.github && (
              <Item
                title={t('settingsAccount.github')}
                subtitle={t('settings.githubConnected', { login: profile.github.login })}
                detail={t('settingsAccount.tapToDisconnect')}
                left={<Github size={18} />}
                onClick={onDisconnectGithub}
              />
            )}
            {otherServices.map((s) => (
              <Item
                key={s}
                title={s}
                detail={t('settingsAccount.tapToDisconnect')}
                left={<ServerIcon size={18} />}
                onClick={() => onDisconnectService(s)}
              />
            ))}
          </ItemGroup>
        )}

        <ItemGroup title={t('settingsAccount.dangerZone')}>
          <Item
            title={t('settingsAccount.logout')}
            subtitle={t('settingsAccount.logoutSubtitle')}
            left={<LogOut size={18} />}
            destructive
            onClick={onLogout}
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Agents
// ===================================================================

function AgentField({
  label,
  options,
  resolvedValue,
  override,
  codeDefault,
  onPick,
}: {
  label: string;
  options: ModeOption[];
  resolvedValue: string | null;
  /** the user's explicit override key, or undefined when using the code default */
  override: string | undefined;
  codeDefault: string | null;
  onPick: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === resolvedValue);

  return (
    <>
      <Item
        title={label}
        right={
          <span className="set-value">
            {current?.name ?? resolvedValue ?? t('settingsAgents.useCodeDefault')}
            {!override && (t('settingsAgents.codeDefaultSuffix'))}
          </span>
        }
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="set-options">
          <Item
            title={t('settingsAgents.useCodeDefault')}
            subtitle={codeDefault ? options.find((o) => o.key === codeDefault)?.name ?? codeDefault : undefined}
            selected={!override}
            right={!override ? <Check size={16} /> : undefined}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          />
          {options.map((o) => (
            <Item
              key={o.key}
              title={o.name}
              subtitle={o.description ?? undefined}
              detail={o.key}
              selected={override === o.key}
              right={override === o.key ? <Check size={16} /> : undefined}
              onClick={() => {
                onPick(o.key);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Which agent the quick "+" flow spawns — same expand-in-place pattern as AgentField. */
function NewSessionAgentField({
  value,
  onPick,
}: {
  value: AgentKey;
  onPick: (agent: AgentKey) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Item
        title={t('settingsAgents.defaultAgent')}
        right={<span className="set-value">{value}</span>}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="set-options">
          {agentKeys.map((a) => (
            <Item
              key={a}
              title={a}
              selected={value === a}
              right={value === a ? <Check size={16} /> : undefined}
              onClick={() => {
                onPick(a);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Agents() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const [overrides, setOverrides] = useSettingMutable('agentDefaultOverrides');
  // Quick new-chat flow (sidebar "+" / palette): which agent it spawns, and
  // whether to always open the full options dialog instead.
  const [newSessionAgent, setNewSessionAgent] = useSettingMutable('newSessionAgent');
  const [alwaysAsk, setAlwaysAsk] = useSettingMutable('newSessionAlwaysAsk');
  const quickAgent = normalizeAgentKey(newSessionAgent);

  const translate = useCallback((k: SimpleTranslationKey) => t(k), []);

  async function clearAll() {
    const ok = await Modal.confirm(
      t('settingsAgents.clearOverrides'),
      t('settingsAgents.clearOverridesConfirm'),
      { confirmText: t('common.reset'), destructive: true },
    );
    if (!ok) return;
    setOverrides({});
    toast.success(t('settingsAgents.cleared'));
  }

  function pick(agent: AgentKey, field: AgentDefaultField, value: string | null) {
    setOverrides(setAgentDefaultOverride(overrides, agent, field, value));
  }

  return (
    <Page>
      <Header
        title={t('settingsAgents.title')}
        subtitle={t('settingsAgents.subtitle')}
        onBack={() => navigate('/settings')}
        right={
          <Button size="sm" variant="ghost" onClick={clearAll}>
            {t('settingsAgents.clearOverrides')}
          </Button>
        }
      />
      <ItemList>
        <ItemGroup
          title={t('settingsAgents.newSessions')}
          footer={t('settingsAgents.newSessionsFooter')}
        >
          <NewSessionAgentField value={quickAgent} onPick={(a) => setNewSessionAgent(a)} />
          <Item
            title={t('settingsAgents.alwaysAsk')}
            subtitle={t('settingsAgents.alwaysAskDescription')}
            right={
              <Toggle
                checked={alwaysAsk === true}
                onChange={setAlwaysAsk}
                label={t('settingsAgents.alwaysAsk')}
              />
            }
          />
        </ItemGroup>
        {agentKeys.map((agent) => {
          const resolved = resolveAgentDefaultConfig(overrides, agent);
          const codeDefaults = resolveAgentDefaultConfig({}, agent);
          const permOptions = getHardcodedPermissionModes(agent, translate);
          const modelOptions = getHardcodedModelModes(agent, translate);
          const effortOptions = getEffortLevelsForModel(agent, resolved.modelMode);
          return (
            <ItemGroup key={agent} title={agent}>
              <AgentField
                label={t('settingsAgents.permission')}
                options={permOptions}
                resolvedValue={resolved.permissionMode}
                override={getAgentDefaultOverrideValue(overrides, agent, 'permissionMode')}
                codeDefault={codeDefaults.permissionMode}
                onPick={(v) => pick(agent, 'permissionMode', v)}
              />
              {modelOptions.length > 0 && (
                <AgentField
                  label={t('settingsAgents.model')}
                  options={modelOptions}
                  resolvedValue={resolved.modelMode}
                  override={getAgentDefaultOverrideValue(overrides, agent, 'modelMode')}
                  codeDefault={codeDefaults.modelMode}
                  onPick={(v) => pick(agent, 'modelMode', v)}
                />
              )}
              {effortOptions.length > 0 && (
                <AgentField
                  label={t('settingsAgents.effort')}
                  options={effortOptions}
                  resolvedValue={resolved.effortLevel}
                  override={getAgentDefaultOverrideValue(overrides, agent, 'effortLevel')}
                  codeDefault={codeDefaults.effortLevel}
                  onPick={(v) => pick(agent, 'effortLevel', v)}
                />
              )}
            </ItemGroup>
          );
        })}
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Snippets
// ===================================================================

type SnippetKind = 'preset' | 'command';
interface EditorState {
  kind: SnippetKind;
  id: string | null;
  title: string;
  body: string;
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function Snippets() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const [presets, setPresets] = useSettingMutable('promptPresets');
  const [commands, setCommands] = useSettingMutable('terminalCommands');
  const [editor, setEditor] = useState<EditorState | null>(null);
  // Startup command for NEW web terminals (synced; daemon skips reattaches).
  // Draft-then-commit so we don't push a settings sync on every keystroke;
  // null draft = "not editing, show the stored value". Empty = disabled.
  const [startupCommand, setStartupCommand] = useSettingMutable('terminalStartupCommand');
  const [startupDraft, setStartupDraft] = useState<string | null>(null);

  function commitStartup() {
    if (startupDraft === null) return;
    const next = startupDraft.trim();
    setStartupDraft(null);
    if (next === (startupCommand ?? '')) return;
    setStartupCommand(next);
    toast.success(t('common.success'));
  }

  function openEditor(kind: SnippetKind, item?: { id: string; title: string; text?: string; command?: string }) {
    setEditor({
      kind,
      id: item?.id ?? null,
      title: item?.title ?? '',
      body: item ? (kind === 'preset' ? item.text ?? '' : item.command ?? '') : '',
    });
  }

  function saveEditor() {
    if (!editor || editor.body.trim().length === 0) return;
    const title = editor.title.trim() || editor.body.trim().split('\n')[0].slice(0, 60);
    if (editor.kind === 'preset') {
      const next = [...(presets ?? [])];
      const entry = { id: editor.id ?? genId(), title, text: editor.body };
      const idx = next.findIndex((p) => p.id === editor.id);
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
      setPresets(next);
    } else {
      const next = [...(commands ?? [])];
      const entry = { id: editor.id ?? genId(), title, command: editor.body };
      const idx = next.findIndex((c) => c.id === editor.id);
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
      setCommands(next);
    }
    setEditor(null);
    toast.success(t('common.success'));
  }

  async function del(kind: SnippetKind, id: string) {
    const ok = await Modal.confirm(
      t('settingsSnippets.deleteTitle'),
      undefined,
      { confirmText: t('settingsSnippets.deleteConfirm'), destructive: true },
    );
    if (!ok) return;
    if (kind === 'preset') setPresets((presets ?? []).filter((p) => p.id !== id));
    else setCommands((commands ?? []).filter((c) => c.id !== id));
  }

  return (
    <Page>
      <Header
        title={t('settingsSnippets.navTitle')}
        subtitle={t('settingsSnippets.navSubtitle')}
        onBack={() => navigate('/settings')}
      />

      {editor && (
        <div className="set-editor">
          <span className="eyebrow">
            {editor.kind === 'preset'
              ? editor.id
                ? t('settingsSnippets.editPreset')
                : t('settingsSnippets.newPreset')
              : editor.id
                ? t('settingsSnippets.editCommand')
                : t('settingsSnippets.newCommand')}
          </span>
          <Input
            label={t('settingsSnippets.editorTitleLabel')}
            placeholder={t('settingsSnippets.editorTitlePlaceholder')}
            value={editor.title}
            onChange={(e) => setEditor({ ...editor, title: e.target.value })}
          />
          <textarea
            className="set-editor__textarea"
            value={editor.body}
            autoFocus
            onChange={(e) => setEditor({ ...editor, body: e.target.value })}
          />
          <div className="set-editor__row">
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {t('settingsSnippets.editorCancel')}
            </Button>
            <Button variant="primary" disabled={editor.body.trim().length === 0} onClick={saveEditor}>
              {t('settingsSnippets.editorSave')}
            </Button>
          </div>
        </div>
      )}

      <ItemList>
        <ItemGroup
          title={t('settingsSnippets.presetsGroup')}
          footer={t('settingsSnippets.presetsFooter')}
        >
          {(presets ?? []).map((p) => (
            <Item
              key={p.id}
              title={p.title || p.text.split('\n')[0]}
              subtitle={p.text}
              right={
                <button
                  type="button"
                  className="set-header__back"
                  aria-label={t('common.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    del('preset', p.id);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              }
              onClick={() => openEditor('preset', p)}
            />
          ))}
          <Item
            title={t('settingsSnippets.addPreset')}
            left={<Plus size={18} />}
            onClick={() => openEditor('preset')}
          />
        </ItemGroup>

        <ItemGroup
          title={t('settingsSnippets.commandsGroup')}
          footer={t('settingsSnippets.commandsFooter')}
        >
          {(commands ?? []).map((c) => (
            <Item
              key={c.id}
              title={c.title || c.command.split('\n')[0]}
              subtitle={c.command}
              right={
                <button
                  type="button"
                  className="set-header__back"
                  aria-label={t('common.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    del('command', c.id);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              }
              onClick={() => openEditor('command', c)}
            />
          ))}
          <Item
            title={t('settingsSnippets.addCommand')}
            left={<Plus size={18} />}
            onClick={() => openEditor('command')}
          />
        </ItemGroup>

        <ItemGroup
          title={t('settingsSnippets.startupGroup')}
          footer={t('settingsSnippets.startupFooter')}
        >
          <div style={{ padding: '10px 16px' }}>
            <Input
              value={startupDraft ?? startupCommand ?? ''}
              placeholder={t('settingsSnippets.startupPlaceholder')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setStartupDraft(e.target.value)}
              onBlur={commitStartup}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Notifications
// ===================================================================

const NOTIF_TYPES: NotifType[] = ['permission_request', 'reply_done', 'input_needed', 'error'];

// Per-type i18n keys, spelled out so tsc can verify each one exists.
const NOTIF_TYPE_LABEL = {
  permission_request: 'notifications.type_permission_request',
  reply_done: 'notifications.type_reply_done',
  input_needed: 'notifications.type_input_needed',
  error: 'notifications.type_error',
} as const satisfies Record<NotifType, string>;

const NOTIF_TYPE_DESC = {
  permission_request: 'notifications.type_permission_request_desc',
  reply_done: 'notifications.type_reply_done_desc',
  input_needed: 'notifications.type_input_needed_desc',
  error: 'notifications.type_error_desc',
} as const satisfies Record<NotifType, string>;

/**
 * Webhook notifications: the SERVER posts a generic {"title","message"} JSON
 * to a user-owned HTTPS endpoint on session events (turn done / permission /
 * question) — e.g. a notify-gateway ingest URL that forwards to a group chat.
 * Independent of browser notification support, so it renders even when Web
 * Push is unavailable. One webhook per account; saving replaces the old one.
 */
function WebhookGroup() {
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [existing, setExisting] = useState(false);
  const [url, setUrl] = useState('');
  // Last URL the SERVER confirmed (GET or successful save). The event toggles
  // persist with THIS, never the input draft: toggling while a half-typed URL
  // sits in the box must not silently submit the draft (or fail on it).
  const [savedUrl, setSavedUrl] = useState('');
  const [completedOn, setCompletedOn] = useState(true);
  const [permissionOn, setPermissionOn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!credentials) return;
    fetchWebhookConfig(credentials)
      .then((config) => {
        if (cancelled) return;
        if (config) {
          setExisting(true);
          setUrl(config.url);
          setSavedUrl(config.url);
          setCompletedOn(config.events.includes('completed'));
          setPermissionOn(config.events.includes('permission'));
        }
      })
      .catch(() => {
        /* keep defaults; user can still type and save */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [credentials]);

  /** Save `nextUrl` + events; returns whether the server accepted it. */
  async function persist(nextUrl: string, nextCompleted: boolean, nextPermission: boolean, announce: boolean): Promise<boolean> {
    if (!credentials) return false;
    const events: WebhookEvent[] = [];
    if (nextCompleted) events.push('completed');
    if (nextPermission) events.push('permission');
    setBusy(true);
    try {
      await saveWebhookConfig(credentials, { url: nextUrl, events });
      setExisting(true);
      setSavedUrl(nextUrl);
      if (announce) toast.success(t('notifications.webhookSaved'));
      return true;
    } catch (e) {
      // Surfaces the server's validation message (https-only, private
      // addresses blocked, …) instead of a generic error.
      toast.error(e instanceof Error ? e.message : (t('common.error')));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Event toggles apply immediately once a webhook exists (like the other
  // toggles on this page); before the first save they just stage state. They
  // submit the SAVED url (see savedUrl) and roll the switch back if the
  // server rejects the save, so the UI never shows a state that didn't stick.
  function toggleCompleted(v: boolean) {
    setCompletedOn(v);
    if (existing && savedUrl.length > 0) {
      void persist(savedUrl, v, permissionOn, false).then((ok) => {
        if (!ok) setCompletedOn(!v);
      });
    }
  }

  function togglePermission(v: boolean) {
    setPermissionOn(v);
    if (existing && savedUrl.length > 0) {
      void persist(savedUrl, completedOn, v, false).then((ok) => {
        if (!ok) setPermissionOn(!v);
      });
    }
  }

  async function remove() {
    if (!credentials) return;
    setBusy(true);
    try {
      await deleteWebhookConfig(credentials);
      setExisting(false);
      setUrl('');
      setSavedUrl('');
      toast.success(t('notifications.webhookRemoved'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ItemGroup
      title={t('notifications.webhook')}
      footer={t('notifications.webhookDescription')}
    >
      <div className="set-webhook">
        <Input
          label={t('notifications.webhookUrl')}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('notifications.webhookUrlPlaceholder')}
          value={url}
          disabled={!loaded || busy}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="set-webhook__row">
          {existing && (
            <Button variant="ghost" disabled={!loaded || busy} onClick={remove}>
              {t('notifications.webhookRemove')}
            </Button>
          )}
          <Button
            variant="primary"
            loading={busy}
            disabled={!loaded || url.trim().length === 0}
            onClick={() => void persist(url.trim(), completedOn, permissionOn, true)}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
      <Item
        title={t('notifications.webhookEventCompleted')}
        subtitle={t('notifications.webhookEventCompletedDesc')}
        right={
          <Toggle
            checked={completedOn}
            disabled={!loaded || busy}
            onChange={toggleCompleted}
            label={t('notifications.webhookEventCompleted')}
          />
        }
      />
      <Item
        title={t('notifications.webhookEventPermission')}
        subtitle={t('notifications.webhookEventPermissionDesc')}
        right={
          <Toggle
            checked={permissionOn}
            disabled={!loaded || busy}
            onChange={togglePermission}
            label={t('notifications.webhookEventPermission')}
          />
        }
      />
    </ItemGroup>
  );
}

/**
 * Pointer left behind on the Notifications page: WebhookGroup moved to the
 * Channels page (webhooks are an integration surface, not a browser-push
 * preference), and rendering the same account-level state twice would mean
 * two competing copies of it. One row, one owner.
 */
function WebhookMovedGroup() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return (
    <ItemGroup>
      <Item
        title={t('settingsChannels.movedTitle')}
        subtitle={t('settingsChannels.movedSubtitle')}
        left={<Cable size={18} />}
        right={<ChevronRight size={16} />}
        onClick={() => navigate('/settings/channels')}
      />
    </ItemGroup>
  );
}

// ===================================================================
// Channels — external integrations hub: outbound webhook notifications
// (stateful, WebhookGroup) + read-only how-to sections for the inbound
// automation surfaces (CLI spawn/send, clipboard MCP, IM adapters).
// ===================================================================

const CHANNELS_DOCS_URL = 'https://github.com/Mereithhh/very-happy/blob/master/docs/channels.md';
// Commands are NOT translated — they are copy-paste material.
const SPAWN_CMD = 'very-happy spawn --dir <directory> --prompt <text> --json';
const SEND_CMD = 'very-happy send --session <session-id> --prompt <text>';
const MCP_CMD = 'claude mcp add --scope user very-happy-clipboard -- very-happy mcp';

function Channels() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <Page>
      <Header
        title={t('settingsChannels.title')}
        subtitle={t('settingsChannels.subtitle')}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        {/* Outbound: server → your endpoint. Carries its own title/footer. */}
        <WebhookGroup />

        {/* Inbound: external tools → sessions. Read-only how-to. */}
        <ItemGroup title={t('settingsChannels.cliTitle')}>
          <div className="set-channel">
            <p className="set-note">{t('settingsChannels.cliIntro')}</p>
            <p className="set-note">{t('settingsChannels.cliSpawnLabel')}</p>
            <CodeView code={SPAWN_CMD} lang="bash" />
            <p className="set-note">{t('settingsChannels.cliSpawnExit')}</p>
            <p className="set-note">{t('settingsChannels.cliSendLabel')}</p>
            <CodeView code={SEND_CMD} lang="bash" />
            <p className="set-note">{t('settingsChannels.cliSendExit')}</p>
          </div>
        </ItemGroup>

        <ItemGroup title={t('settingsChannels.mcpTitle')}>
          <div className="set-channel">
            <p className="set-note">{t('settingsChannels.mcpIntro')}</p>
            <CodeView code={MCP_CMD} lang="bash" />
          </div>
          <ClipboardReceiveItems />
        </ItemGroup>

        <ItemGroup title={t('settingsChannels.imTitle')}>
          <div className="set-channel">
            <p className="set-note">{t('settingsChannels.imIntro')}</p>
          </div>
          <Item
            title={t('settingsChannels.imDocs')}
            subtitle={t('settingsChannels.imDocsSubtitle')}
            left={<BookOpen size={18} />}
            right={<ExternalLink size={16} />}
            onClick={() => window.open(CHANNELS_DOCS_URL, '_blank', 'noopener,noreferrer')}
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

/** Receive-side behaviour of the clipboard MCP tool: the device-local
 *  auto-copy toggle + the entry point to the received-content history panel
 *  (the ⌘K "Clipboard history" action opens the same panel). */
function ClipboardReceiveItems() {
  const { t } = useTranslation();
  const [autoCopy, setAutoCopy] = useLocalSettingMutable('clipboardAutoCopy');
  return (
    <>
      <Item
        title={t('clipboard.autoCopyTitle')}
        subtitle={t('clipboard.autoCopySubtitle')}
        right={
          <Toggle
            checked={autoCopy}
            onChange={setAutoCopy}
            label={t('clipboard.autoCopyTitle')}
          />
        }
      />
      <Item
        title={t('clipboard.historyTitle')}
        subtitle={t('clipboard.historyOpenSubtitle')}
        left={<ClipboardList size={18} />}
        right={<ChevronRight size={16} />}
        onClick={openClipboardHistory}
      />
    </>
  );
}

// --- notification sound (WebAudio chime — device-local, no OS permission) ---

const CHIME_VOICE_LABEL: Record<ChimeVoice, SimpleTranslationKey> = {
  ding: 'notifications.voiceDing',
  duo: 'notifications.voiceDuo',
  woodblock: 'notifications.voiceWoodblock',
  melody: 'notifications.voiceMelody',
};

const SOUND_EVENTS: SoundEvent[] = ['permission', 'question', 'done'];

const SOUND_EVENT_LABEL: Record<SoundEvent, SimpleTranslationKey> = {
  permission: 'notifications.soundEventPermission',
  question: 'notifications.soundEventQuestion',
  done: 'notifications.soundEventDone',
};

const SOUND_EVENT_DESC: Record<SoundEvent, SimpleTranslationKey> = {
  permission: 'notifications.soundEventPermissionDesc',
  question: 'notifications.soundEventQuestionDesc',
  done: 'notifications.soundEventDoneDesc',
};

/** Chime settings. Rendered even where browser Notifications are unsupported —
 *  WebAudio needs no permission, only a first user gesture (autoplay policy;
 *  the settings clicks themselves unlock it). */
function SoundGroups() {
  const { t } = useTranslation();
  const prefs = useSoundPrefs();

  // Preview reads prefs from the store (not the render closure) so the value
  // just committed by the same interaction is what plays.
  const preview = (voice?: ChimeVoice) => {
    const cur = getSoundPrefs();
    playChime(voice ?? cur.voice, cur.volume);
  };

  return (
    <>
      <ItemGroup title={t('notifications.sound')} footer={t('notifications.soundDescription')}>
        <Item
          title={t('notifications.soundEnable')}
          right={
            <Toggle
              checked={prefs.enabled}
              onChange={(v) => updateSoundPrefs({ enabled: v })}
              label={t('notifications.soundEnable')}
            />
          }
        />
        <Item
          title={t('notifications.soundVolume')}
          right={
            <input
              type="range"
              className="set-range"
              min={0}
              max={100}
              step={5}
              value={Math.round(prefs.volume * 100)}
              disabled={!prefs.enabled}
              aria-label={t('notifications.soundVolume')}
              onChange={(e) => updateSoundPrefs({ volume: Number(e.target.value) / 100 })}
              onPointerUp={() => preview()}
              onKeyUp={(e) => {
                if (e.key.startsWith('Arrow')) preview();
              }}
            />
          }
        />
      </ItemGroup>

      <ItemGroup title={t('notifications.soundVoice')} footer={t('notifications.soundVoiceDescription')}>
        {CHIME_VOICES.map((voice) => (
          <Item
            key={voice}
            title={t(CHIME_VOICE_LABEL[voice])}
            selected={prefs.voice === voice}
            onClick={() => {
              updateSoundPrefs({ voice });
              preview(voice);
            }}
            right={
              <span className="set-voice-right">
                <button
                  type="button"
                  className="set-voice-preview"
                  title={t('notifications.soundPreview')}
                  aria-label={t('notifications.soundPreview')}
                  onClick={(e) => {
                    e.stopPropagation();
                    preview(voice);
                  }}
                >
                  <Volume2 size={15} />
                </button>
                {prefs.voice === voice && <Check size={16} />}
              </span>
            }
          />
        ))}
      </ItemGroup>

      <ItemGroup title={t('notifications.soundEvents')} footer={t('notifications.soundEventsDescription')}>
        {SOUND_EVENTS.map((ev) => (
          <Item
            key={ev}
            title={t(SOUND_EVENT_LABEL[ev])}
            subtitle={t(SOUND_EVENT_DESC[ev])}
            right={
              <Toggle
                checked={prefs.events[ev]}
                disabled={!prefs.enabled}
                onChange={(v) => setSoundEventEnabled(ev, v)}
                label={t(SOUND_EVENT_LABEL[ev])}
              />
            }
          />
        ))}
      </ItemGroup>
    </>
  );
}

/** Notification-center behaviour: how long entries stay in the bell panel. */
function InboxGroup() {
  const { t } = useTranslation();
  const days = useRetentionDays();
  return (
    <ItemGroup
      title={t('notifications.inboxGroup')}
      footer={t('notifications.inboxRetentionDescription')}
    >
      {RETENTION_DAY_OPTIONS.map((d) => (
        <Item
          key={d}
          title={t('notifications.retentionDays', { days: d })}
          selected={days === d}
          right={days === d ? <Check size={16} /> : undefined}
          onClick={() => setRetentionDays(d)}
        />
      ))}
    </ItemGroup>
  );
}

function Notifications() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const prefs = useNotificationPrefs();
  const supported = isWebPushSupported() && getNotificationPermission() !== 'unsupported';
  const permission = getNotificationPermission();
  const [busy, setBusy] = useState(false);

  if (!supported) {
    return (
      <Page>
        <Header title={t('notifications.title')} onBack={() => navigate('/settings')} />
        <ItemList>
          <ItemGroup title={t('notifications.webOnly')}>
            <Item title={t('notifications.unsupported')} />
          </ItemGroup>
          {/* the chime + notification center work without the Notification API */}
          <SoundGroups />
          <InboxGroup />
          <WebhookMovedGroup />
        </ItemList>
      </Page>
    );
  }

  async function toggleMaster(on: boolean) {
    setBusy(true);
    try {
      if (on) {
        const granted = (await requestNotificationPermission()) === 'granted';
        if (!granted) {
          setBusy(false);
          return;
        }
        if (credentials) await enableWebPush(credentials);
      } else if (credentials) {
        await disableWebPush(credentials);
      }
      setNotificationPrefs({ ...prefs, enabled: on });
    } finally {
      setBusy(false);
    }
  }

  function timeToMinute(v: string): number {
    const [h, m] = v.split(':').map((x) => parseInt(x, 10));
    return (h || 0) * 60 + (m || 0);
  }

  const denied = permission === 'denied';

  return (
    <Page>
      <Header
        title={t('notifications.title')}
        subtitle={t('notifications.settingsSubtitle')}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup
          title={t('notifications.browserNotifications')}
          footer={
            denied
              ? (t('notifications.permissionDeniedHint'))
              : (t('notifications.masterDescription'))
          }
        >
          <Item
            title={t('notifications.enable')}
            subtitle={prefs.enabled ? t('notifications.enabledOn') : t('notifications.enabledOff')}
            right={
              busy ? (
                <Spinner size={14} />
              ) : (
                <Toggle
                  checked={prefs.enabled}
                  disabled={denied}
                  onChange={toggleMaster}
                  label={t('notifications.enable')}
                />
              )
            }
          />
        </ItemGroup>

        <ItemGroup
          title={t('notifications.types')}
          footer={t('notifications.typesDescription')}
        >
          {NOTIF_TYPES.map((type) => (
            <Item
              key={type}
              title={t(NOTIF_TYPE_LABEL[type])}
              subtitle={t(NOTIF_TYPE_DESC[type])}
              right={
                <Toggle
                  checked={prefs.types[type]}
                  disabled={!prefs.enabled}
                  onChange={(v) => setTypeEnabled(type, v)}
                  label={t(NOTIF_TYPE_LABEL[type])}
                />
              }
            />
          ))}
        </ItemGroup>

        <ItemGroup
          title={t('notifications.quietHours')}
          footer={t('notifications.quietHoursDescription')}
        >
          <Item
            title={t('notifications.quietHoursEnable')}
            right={
              <Toggle
                checked={prefs.quietHours.enabled}
                disabled={!prefs.enabled}
                onChange={(v) => setQuietHours({ enabled: v })}
                label={t('notifications.quietHoursEnable')}
              />
            }
          />
          {prefs.quietHours.enabled && (
            <>
              <Item
                title={t('notifications.quietHoursStart')}
                right={
                  <input
                    type="time"
                    className="set-value"
                    value={formatMinute(prefs.quietHours.startMinute)}
                    onChange={(e) => setQuietHours({ startMinute: timeToMinute(e.target.value) })}
                  />
                }
              />
              <Item
                title={t('notifications.quietHoursEnd')}
                right={
                  <input
                    type="time"
                    className="set-value"
                    value={formatMinute(prefs.quietHours.endMinute)}
                    onChange={(e) => setQuietHours({ endMinute: timeToMinute(e.target.value) })}
                  />
                }
              />
            </>
          )}
        </ItemGroup>

        <SoundGroups />
        <InboxGroup />
        <WebhookMovedGroup />
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Usage
// ===================================================================

type Period = 'today' | '7days' | '30days';

function Usage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const [period, setPeriod] = useState<Period>('7days');
  const [data, setData] = useState<UsageDataPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!credentials) return;
    setLoading(true);
    setError(false);
    getUsageForPeriod(credentials, period)
      .then((res) => {
        if (!cancelled) setData(res.usage);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentials, period]);

  const totals = useMemo(() => (data ? calculateTotals(data) : null), [data]);
  const maxTokens = useMemo(() => {
    if (!data || data.length === 0) return 0;
    return Math.max(
      ...data.map((d) => Object.values(d.tokens).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)),
    );
  }, [data]);

  const periods: { key: Period; label: string }[] = [
    { key: 'today', label: t('usage.today') },
    { key: '7days', label: t('usage.last7Days') },
    { key: '30days', label: t('usage.last30Days') },
  ];

  return (
    <Page>
      <Header
        title={t('settings.usage')}
        subtitle={t('settings.usageSubtitle')}
        onBack={() => navigate('/settings')}
        right={
          <div className="set-seg">
            {periods.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`set-seg__btn${period === p.key ? ' is-active' : ''}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="set-center">
          <Spinner size={16} /> {t('common.loading')}
        </div>
      ) : error || !totals ? (
        <div className="set-center">{t('usage.noData')}</div>
      ) : totals.totalTokens === 0 ? (
        <div className="set-center">{t('usage.noData')}</div>
      ) : (
        <>
          <div className="set-stat-row">
            <div className="set-stat">
              <span className="set-stat__label">{t('usage.totalTokens')}</span>
              <span className="set-stat__value">{formatCompact(totals.totalTokens)}</span>
            </div>
            <div className="set-stat">
              <span className="set-stat__label">{t('usage.totalCost')}</span>
              <span className="set-stat__value">${totals.totalCost.toFixed(2)}</span>
            </div>
          </div>

          <ItemGroup title={t('usage.usageOverTime')}>
            <div style={{ padding: 'var(--sp-2) var(--sp-3) var(--sp-3)' }}>
              <div className="set-chart">
                {data!.map((d, i) => {
                  const tok = Object.values(d.tokens).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
                  const h = maxTokens > 0 ? (tok / maxTokens) * 100 : 0;
                  return (
                    <div
                      key={i}
                      className={`set-chart__bar${tok > 0 ? ' set-chart__bar--filled' : ''}`}
                      style={{ height: `${h}%` }}
                      title={`${formatCompact(tok)} tokens`}
                    />
                  );
                })}
              </div>
            </div>
          </ItemGroup>

          <ItemGroup title={t('usage.byModel')}>
            {Object.entries(totals.tokensByModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, tokens]) => (
                <Item
                  key={model}
                  title={model}
                  detail={`${formatCompact(tokens)} ${(t('usage.tokens')).toLowerCase()}`}
                  right={<span className="set-value">${(totals.costByModel[model] ?? 0).toFixed(2)}</span>}
                />
              ))}
          </ItemGroup>
        </>
      )}
    </Page>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ===================================================================
// Diagnostics
// ===================================================================

function statusLabel(t: any, status: string): string {
  switch (status) {
    case 'connected':
      return t('diagnostics.statusConnected');
    case 'connecting':
      return t('diagnostics.statusConnecting');
    case 'error':
      return t('diagnostics.statusError');
    case 'idle':
      return t('diagnostics.statusIdle');
    default:
      return t('diagnostics.statusDisconnected');
  }
}

/** Web build identity + manual update check. The build id is the VH_VERSION
 *  deploy salt (a timestamp) baked in at build time — the ANSWER to "is my
 *  phone's PWA stale?". The button runs the same comparison the automatic
 *  stale-bundle watcher uses (app/staleBundleReload.ts) and reloads on match
 *  failure, so a suspended-then-woken PWA can be force-updated by hand. */
function WebBuildGroup() {
  const { t } = useTranslation();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await checkForUpdateNow();
      if (r === 'current') toast.success(t('diagnostics.webBuildCurrent'));
      else if (r === 'updated') toast.success(t('diagnostics.webBuildUpdating'));
      else toast.error(t('diagnostics.webBuildCheckFailed'));
    } finally {
      setChecking(false);
    }
  };
  return (
    <ItemGroup title={t('diagnostics.webBuild')}>
      <Item
        title={t('diagnostics.webBuildVersion')}
        right={<span className="set-value mono">{__APP_VERSION__}</span>}
      />
      <Item
        title={checking ? t('diagnostics.webBuildChecking') : t('diagnostics.webBuildCheck')}
        onClick={() => void check()}
      />
    </ItemGroup>
  );
}

function Diagnostics() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const socket = useSocketStatus();
  const machines = useAllMachines({ includeOffline: true });
  // Developer/troubleshooting toggles — device-local, consumed by
  // apiSocket.isVerboseLogging() and utils/consoleLogging respectively.
  const [verboseLogging, setVerboseLogging] = useLocalSettingMutable('verboseLogging');
  const [consoleLogging, setConsoleLogging] = useLocalSettingMutable('consoleLoggingEnabled');

  const socketTone =
    socket.status === 'connected' ? 'connected' : socket.status === 'connecting' ? 'thinking' : 'offline';

  return (
    <Page>
      <Header
        title={t('diagnostics.title')}
        subtitle={t('diagnostics.subtitle')}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <WebBuildGroup />
        <ItemGroup title={t('diagnostics.relay')}>
          <Item
            title={t('diagnostics.serverSocket')}
            subtitle={
              socket.lastConnectedAt
                ? `${t('diagnostics.lastConnected')}: ${new Date(socket.lastConnectedAt).toLocaleString()}`
                : undefined
            }
            left={<StatusDot status={socketTone as any} pulse={socket.status === 'connected'} />}
            right={<span className="set-value">{statusLabel(t, socket.status)}</span>}
          />
        </ItemGroup>

        <ItemGroup title={t('diagnostics.machinesAndDaemons')}>
          {machines.length === 0 ? (
            <Item title={t('diagnostics.noMachines')} />
          ) : (
            machines.map((m) => {
              const online = m.active;
              const cli = m.metadata?.cliAvailability;
              const claudeMissing = online && cli && !cli.claude;
              const name = m.metadata?.displayName || m.metadata?.host || m.id;
              const daemonStatus = m.metadata?.daemonLastKnownStatus;
              return (
                <Item
                  key={m.id}
                  title={name}
                  subtitle={
                    claudeMissing
                      ? (t('diagnostics.cliMissing', { cli: 'claude' }))
                      : daemonStatus
                        ? `${t('diagnostics.daemonStatus')}: ${daemonStatus}`
                        : undefined
                  }
                  detail={m.metadata?.host}
                  left={<StatusDot status={online ? 'connected' : 'offline'} />}
                  right={
                    <Badge tone={claudeMissing ? 'err' : online ? 'live' : 'muted'}>
                      {online ? t('diagnostics.online') : t('diagnostics.offline')}
                    </Badge>
                  }
                  onClick={() => navigate(`/machine/${m.id}`)}
                />
              );
            })
          )}
        </ItemGroup>
        <div className="set-note">{t('diagnostics.cliHint')}</div>

        <ItemGroup
          title={t('diagnostics.developer')}
          footer={t('diagnostics.developerFooter')}
        >
          <Item
            title={t('diagnostics.verboseLogging')}
            subtitle={t('diagnostics.verboseLoggingDescription')}
            right={
              <Toggle
                checked={verboseLogging}
                onChange={setVerboseLogging}
                label={t('diagnostics.verboseLogging')}
              />
            }
          />
          <Item
            title={t('diagnostics.consoleLogging')}
            subtitle={t('diagnostics.consoleLoggingDescription')}
            right={
              <Toggle
                checked={consoleLogging}
                onChange={(v) => {
                  setConsoleLogging(v);
                  // Apply immediately — initConsoleLogging only reads the
                  // stored value once at startup.
                  setConsoleOutputEnabled(v);
                }}
                label={t('diagnostics.consoleLogging')}
              />
            }
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Password
// ===================================================================

function Password() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { credentials } = useAuth();
  const toast = useToast();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState<{ u?: boolean; p?: boolean; c?: boolean }>({});

  const usernameError = touched.u && username.trim().length === 0 ? (t('profile.username')) : null;
  const passwordError =
    touched.p && password.length < MIN_PASSWORD
      ? (t('setPassword.errorTooShort', { count: MIN_PASSWORD }))
      : null;
  const confirmError =
    touched.c && confirm.length > 0 && confirm !== password ? (t('setPassword.errorMismatch')) : null;

  const canSubmit =
    username.trim().length > 0 && password.length >= MIN_PASSWORD && confirm === password && !busy && !!credentials;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ u: true, p: true, c: true });
    if (!canSubmit || !credentials) return;
    setBusy(true);
    setServerError(null);
    try {
      await setAccountCredentials(username, password, credentials.secret, credentials);
      toast.success(t('setPassword.success'));
      setPassword('');
      setConfirm('');
      navigate('/settings/account');
    } catch (err: any) {
      if (err instanceof AccountAuthError && err.code === 'username-taken') {
        setServerError(t('signup.errorUsernameTaken'));
      } else {
        setServerError(t('setPassword.errorSaveFailed'));
      }
      setPassword('');
      setConfirm('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <Header title={t('settingsAccount.password')} onBack={() => navigate('/settings')} />
      <div className="set-note">{t('setPassword.intro')}</div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <Input
          label={t('profile.username')}
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onBlur={() => setTouched((s) => ({ ...s, u: true }))}
          error={usernameError}
        />
        <Input
          label={t('setPassword.passwordLabel')}
          type="password"
          autoComplete="new-password"
          placeholder={t('setPassword.passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, p: true }))}
          error={passwordError}
        />
        <Input
          label={t('setPassword.confirmLabel')}
          type="password"
          autoComplete="new-password"
          placeholder={t('setPassword.confirmPlaceholder')}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, c: true }))}
          error={confirmError ?? serverError}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          {t('setPassword.save')}
        </Button>
      </form>
    </Page>
  );
}

// ===================================================================
// Routes
// ===================================================================

export function SettingsRoutes() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="appearance" element={<Appearance />} />
      <Route path="account" element={<Account />} />
      <Route path="agents" element={<Agents />} />
      <Route path="snippets" element={<Snippets />} />
      <Route path="notifications" element={<Notifications />} />
      <Route path="channels" element={<Channels />} />
      <Route path="voice" element={<VoiceSettings />} />
      <Route path="usage" element={<Usage />} />
      <Route path="diagnostics" element={<Diagnostics />} />
      <Route path="password" element={<Password />} />
    </Routes>
  );
}
