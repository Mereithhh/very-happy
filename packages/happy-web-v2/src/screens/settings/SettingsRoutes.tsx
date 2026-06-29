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
  BarChart3,
  Stethoscope,
  KeyRound,
  LogOut,
  Check,
  Plus,
  Trash2,
  Github,
  Server as ServerIcon,
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
import { useTranslation, type SupportedLanguage } from '@/i18n/useTranslation';
import { SUPPORTED_LANGUAGES } from '@/text/_all';
import {
  useSettingMutable,
  useProfile,
  useAllMachines,
  useSocketStatus,
  useRealtimeStatus,
} from '@/sync/storage';
import { sync } from '@/sync/sync';
import {
  agentKeys,
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
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
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
import type { NotifType } from '@/sync/feedTypes';
import { getUsageForPeriod, calculateTotals, type UsageDataPoint } from '@/sync/apiUsage';
import { getServerInfo } from '@/sync/serverConfig';
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
      t('settingsAccount.logout' as any) as string,
      t('settingsAccount.logoutConfirm' as any) as string,
      { confirmText: t('common.logout' as any) as string, destructive: true },
    );
    if (ok) await logout();
  }

  return (
    <Page>
      <Header title={t('settings.title' as any) as string} onBack={() => navigate('/')} />
      <ItemList>
        <ItemGroup>
          <Item
            title={t('settings.account' as any)}
            subtitle={t('settings.accountSubtitle' as any)}
            left={<User size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/account')}
          />
          <Item
            title={t('settings.appearance' as any)}
            subtitle={t('settings.appearanceSubtitle' as any)}
            left={<Palette size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/appearance')}
          />
          <Item
            title={t('settingsAgents.title' as any)}
            subtitle={t('settingsAgents.subtitle' as any)}
            left={<Bot size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/agents')}
          />
          <Item
            title={t('settingsSnippets.navTitle' as any)}
            subtitle={t('settingsSnippets.navSubtitle' as any)}
            left={<Bookmark size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/snippets')}
          />
          <Item
            title={t('notifications.title' as any)}
            subtitle={t('notifications.settingsSubtitle' as any)}
            left={<Bell size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/notifications')}
          />
          <Item
            title={t('settings.usage' as any)}
            subtitle={t('settings.usageSubtitle' as any)}
            left={<BarChart3 size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/usage')}
          />
          <Item
            title={t('diagnostics.title' as any)}
            subtitle={t('diagnostics.subtitle' as any)}
            left={<Stethoscope size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/diagnostics')}
          />
          <Item
            title={t('settingsAccount.password' as any)}
            subtitle={t('settingsAccount.passwordChange' as any)}
            left={<KeyRound size={18} />}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/password')}
          />
        </ItemGroup>

        <ItemGroup title={t('settingsAccount.dangerZone' as any) as string}>
          <Item
            title={t('settingsAccount.logout' as any)}
            subtitle={t('settingsAccount.logoutSubtitle' as any)}
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
  const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
  const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
  const [expandTodos, setExpandTodos] = useSettingMutable('expandTodos');
  const [showLineNumbers, setShowLineNumbers] = useSettingMutable('showLineNumbers');
  const [, setPreferredLanguage] = useSettingMutable('preferredLanguage');

  const themeOpts: { key: 'system' | 'dark' | 'light'; label: string; desc: string }[] = [
    {
      key: 'system',
      label: t('settingsAppearance.themeOptions.adaptive' as any) as string,
      desc: t('settingsAppearance.themeDescriptions.adaptive' as any) as string,
    },
    {
      key: 'light',
      label: t('settingsAppearance.themeOptions.light' as any) as string,
      desc: t('settingsAppearance.themeDescriptions.light' as any) as string,
    },
    {
      key: 'dark',
      label: t('settingsAppearance.themeOptions.dark' as any) as string,
      desc: t('settingsAppearance.themeDescriptions.dark' as any) as string,
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
        title={t('settings.appearance' as any) as string}
        subtitle={t('settings.appearanceSubtitle' as any) as string}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup
          title={t('settingsAppearance.theme' as any) as string}
          footer={t('settingsAppearance.themeDescription' as any) as string}
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
          title={t('settingsLanguage.title' as any) as string}
          footer={t('settingsLanguage.description' as any) as string}
        >
          <Item
            title={t('settingsLanguage.automatic' as any)}
            subtitle={t('settingsLanguage.automaticSubtitle' as any)}
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
          title={t('settingsAppearance.display' as any) as string}
          footer={t('settingsAppearance.displayDescription' as any) as string}
        >
          <Item
            title={t('settingsAppearance.diffStyle' as any)}
            subtitle={t('settingsAppearance.diffStyleDescription' as any)}
            right={
              <div className="set-seg">
                {(['unified', 'split'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`set-seg__btn${diffStyle === s ? ' is-active' : ''}`}
                    onClick={() => setDiffStyle(s)}
                  >
                    {t(`settingsAppearance.diffStyleOptions.${s}` as any)}
                  </button>
                ))}
              </div>
            }
          />
          <Item
            title={t('settingsAppearance.avatarStyle' as any)}
            subtitle={t('settingsAppearance.avatarStyleDescription' as any)}
            right={
              <div className="set-seg">
                {(['gradient', 'pixelated'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`set-seg__btn${avatarStyle === s ? ' is-active' : ''}`}
                    onClick={() => setAvatarStyle(s)}
                  >
                    {t(`settingsAppearance.avatarOptions.${s}` as any)}
                  </button>
                ))}
              </div>
            }
          />
          <Item
            title={t('settingsAppearance.expandTodoLists' as any)}
            subtitle={t('settingsAppearance.expandTodoListsDescription' as any)}
            right={
              <Toggle
                checked={expandTodos}
                onChange={setExpandTodos}
                label={t('settingsAppearance.expandTodoLists' as any) as string}
              />
            }
          />
          <Item
            title={t('settingsAppearance.showLineNumbersInDiffs' as any)}
            subtitle={t('settingsAppearance.showLineNumbersInDiffsDescription' as any)}
            right={
              <Toggle
                checked={showLineNumbers}
                onChange={setShowLineNumbers}
                label={t('settingsAppearance.showLineNumbersInDiffs' as any) as string}
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
  const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');

  const [revealSecret, setRevealSecret] = useState(false);
  const [pushOn, setPushOn] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');
  const [pushBusy, setPushBusy] = useState(false);

  const displayName = getDisplayName(profile);
  const avatarUrl = getAvatarUrl(profile);
  const serverInfo = getServerInfo();
  const secretFormatted = credentials?.secret ? formatSecretKeyForBackup(credentials.secret) : null;

  async function copySecret() {
    if (!credentials?.secret) return;
    try {
      await navigator.clipboard.writeText(credentials.secret);
      toast.success(t('settingsAccount.secretKeyCopied' as any) as string);
    } catch {
      toast.error(t('settingsAccount.secretKeyCopyFailed' as any) as string);
    }
  }

  async function togglePush(on: boolean) {
    if (!credentials) return;
    setPushBusy(true);
    try {
      if (on) {
        const ok = await enableWebPush(credentials);
        setPushOn(ok);
        if (ok) toast.success(t('common.success' as any) as string);
      } else {
        await disableWebPush(credentials);
        setPushOn(false);
      }
    } finally {
      setPushBusy(false);
    }
  }

  async function onDisconnectGithub() {
    if (!credentials) return;
    const ok = await Modal.confirm(
      t('modals.disconnectGithub' as any) as string,
      t('modals.disconnectGithubConfirm' as any) as string,
      { confirmText: t('modals.disconnect' as any) as string, destructive: true },
    );
    if (!ok) return;
    try {
      await disconnectGitHub(credentials);
      await sync.refreshProfile();
      toast.success(t('common.success' as any) as string);
    } catch {
      toast.error(t('common.error' as any) as string);
    }
  }

  async function onDisconnectService(service: string) {
    if (!credentials) return;
    const ok = await Modal.confirm(
      t('modals.disconnectService' as any, { service } as any) as string,
      t('modals.disconnectServiceConfirm' as any, { service } as any) as string,
      { confirmText: t('modals.disconnect' as any) as string, destructive: true },
    );
    if (!ok) return;
    try {
      await disconnectService(credentials, service);
      await sync.refreshProfile();
      toast.success(t('common.success' as any) as string);
    } catch {
      toast.error(t('common.error' as any) as string);
    }
  }

  async function onLogout() {
    const ok = await Modal.confirm(
      t('settingsAccount.logout' as any) as string,
      t('settingsAccount.logoutConfirm' as any) as string,
      { confirmText: t('common.logout' as any) as string, destructive: true },
    );
    if (ok) await logout();
  }

  const otherServices = (profile.connectedServices ?? []).filter((s) => s !== 'github');

  return (
    <Page>
      <Header
        title={t('settings.account' as any) as string}
        subtitle={t('settings.accountSubtitle' as any) as string}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup title={t('settingsAccount.accountInformation' as any) as string}>
          <Item
            title={t('settingsAccount.status' as any)}
            right={
              <Badge tone={credentials ? 'live' : 'muted'}>
                {credentials ? t('settingsAccount.statusActive' as any) : t('settingsAccount.statusNotAuthenticated' as any)}
              </Badge>
            }
          />
          {profile.id && (
            <Item title={t('settingsAccount.publicId' as any)} detail={profile.id} />
          )}
          <Item
            title={t('settingsAccount.password' as any)}
            subtitle={t('settingsAccount.passwordChange' as any)}
            right={<ChevronRight size={16} />}
            onClick={() => navigate('/settings/password')}
          />
          <Item title={t('settingsAccount.server' as any)} detail={serverInfo.hostname} />
        </ItemGroup>

        {(profile.github || displayName || avatarUrl) && (
          <ItemGroup title={t('settingsAccount.profile' as any) as string}>
            {displayName && <Item title={t('settingsAccount.name' as any)} subtitle={displayName} />}
            {profile.github && (
              <Item
                title={t('settingsAccount.github' as any)}
                subtitle={t('settings.githubConnected' as any, { login: profile.github.login } as any)}
                detail={t('settingsAccount.tapToDisconnect' as any) as string}
                left={<Github size={18} />}
                onClick={onDisconnectGithub}
              />
            )}
            {otherServices.map((s) => (
              <Item
                key={s}
                title={s}
                detail={t('settingsAccount.tapToDisconnect' as any) as string}
                left={<ServerIcon size={18} />}
                onClick={() => onDisconnectService(s)}
              />
            ))}
          </ItemGroup>
        )}

        {secretFormatted && (
          <ItemGroup
            title={t('settingsAccount.backup' as any) as string}
            footer={t('settingsAccount.backupDescription' as any) as string}
          >
            <Item
              title={t('settingsAccount.secretKey' as any)}
              subtitle={revealSecret ? t('settingsAccount.tapToHide' as any) : t('settingsAccount.tapToReveal' as any)}
              detail={revealSecret ? secretFormatted : undefined}
              onClick={() => setRevealSecret((v) => !v)}
            />
            {revealSecret && (
              <Item title={t('settingsAccount.secretKeyLabel' as any)} onClick={copySecret} />
            )}
          </ItemGroup>
        )}

        {isWebPushSupported() && (
          <ItemGroup
            title={t('notifications.browserNotifications' as any) as string}
            footer={t('notifications.masterDescription' as any) as string}
          >
            <Item
              title={t('notifications.enable' as any)}
              subtitle={pushOn ? t('notifications.enabledOn' as any) : t('notifications.enabledOff' as any)}
              right={
                pushBusy ? (
                  <Spinner size={14} />
                ) : (
                  <Toggle checked={pushOn} onChange={togglePush} label={t('notifications.enable' as any) as string} />
                )
              }
            />
          </ItemGroup>
        )}

        <ItemGroup
          title={t('settingsAccount.privacy' as any) as string}
          footer={t('settingsAccount.privacyDescription' as any) as string}
        >
          <Item
            title={t('settingsAccount.analytics' as any)}
            subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled' as any) : t('settingsAccount.analyticsEnabled' as any)}
            right={
              <Toggle
                checked={!analyticsOptOut}
                onChange={(v) => setAnalyticsOptOut(!v)}
                label={t('settingsAccount.analytics' as any) as string}
              />
            }
          />
        </ItemGroup>

        <ItemGroup title={t('settingsAccount.dangerZone' as any) as string}>
          <Item
            title={t('settingsAccount.logout' as any)}
            subtitle={t('settingsAccount.logoutSubtitle' as any)}
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
            {current?.name ?? resolvedValue ?? t('settingsAgents.useCodeDefault' as any)}
            {!override && (t('settingsAgents.codeDefaultSuffix' as any) as string)}
          </span>
        }
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="set-options">
          <Item
            title={t('settingsAgents.useCodeDefault' as any)}
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

function Agents() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useToast();
  const [overrides, setOverrides] = useSettingMutable('agentDefaultOverrides');

  const translate = useCallback((k: any) => t(k), [t]);

  async function clearAll() {
    const ok = await Modal.confirm(
      t('settingsAgents.clearOverrides' as any) as string,
      t('settingsAgents.clearOverridesConfirm' as any) as string,
      { confirmText: t('common.reset' as any) as string, destructive: true },
    );
    if (!ok) return;
    setOverrides({});
    toast.success(t('settingsAgents.cleared' as any) as string);
  }

  function pick(agent: AgentKey, field: AgentDefaultField, value: string | null) {
    setOverrides(setAgentDefaultOverride(overrides, agent, field, value));
  }

  return (
    <Page>
      <Header
        title={t('settingsAgents.title' as any) as string}
        subtitle={t('settingsAgents.subtitle' as any) as string}
        onBack={() => navigate('/settings')}
        right={
          <Button size="sm" variant="ghost" onClick={clearAll}>
            {t('settingsAgents.clearOverrides' as any)}
          </Button>
        }
      />
      <ItemList>
        {agentKeys.map((agent) => {
          const resolved = resolveAgentDefaultConfig(overrides, agent);
          const codeDefaults = resolveAgentDefaultConfig({}, agent);
          const permOptions = getHardcodedPermissionModes(agent, translate);
          const modelOptions = getHardcodedModelModes(agent, translate);
          const effortOptions = getEffortLevelsForModel(agent, resolved.modelMode);
          return (
            <ItemGroup key={agent} title={agent}>
              <AgentField
                label={t('settingsAgents.permission' as any) as string}
                options={permOptions}
                resolvedValue={resolved.permissionMode}
                override={getAgentDefaultOverrideValue(overrides, agent, 'permissionMode')}
                codeDefault={codeDefaults.permissionMode}
                onPick={(v) => pick(agent, 'permissionMode', v)}
              />
              {modelOptions.length > 0 && (
                <AgentField
                  label={t('settingsAgents.model' as any) as string}
                  options={modelOptions}
                  resolvedValue={resolved.modelMode}
                  override={getAgentDefaultOverrideValue(overrides, agent, 'modelMode')}
                  codeDefault={codeDefaults.modelMode}
                  onPick={(v) => pick(agent, 'modelMode', v)}
                />
              )}
              {effortOptions.length > 0 && (
                <AgentField
                  label={t('settingsAgents.effort' as any) as string}
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
    toast.success(t('common.success' as any) as string);
  }

  async function del(kind: SnippetKind, id: string) {
    const ok = await Modal.confirm(
      t('settingsSnippets.deleteTitle' as any) as string,
      undefined,
      { confirmText: t('settingsSnippets.deleteConfirm' as any) as string, destructive: true },
    );
    if (!ok) return;
    if (kind === 'preset') setPresets((presets ?? []).filter((p) => p.id !== id));
    else setCommands((commands ?? []).filter((c) => c.id !== id));
  }

  return (
    <Page>
      <Header
        title={t('settingsSnippets.navTitle' as any) as string}
        subtitle={t('settingsSnippets.navSubtitle' as any) as string}
        onBack={() => navigate('/settings')}
      />

      {editor && (
        <div className="set-editor">
          <span className="eyebrow">
            {editor.kind === 'preset'
              ? editor.id
                ? t('settingsSnippets.editPreset' as any)
                : t('settingsSnippets.newPreset' as any)
              : editor.id
                ? t('settingsSnippets.editCommand' as any)
                : t('settingsSnippets.newCommand' as any)}
          </span>
          <Input
            label={t('settingsSnippets.editorTitleLabel' as any) as string}
            placeholder={t('settingsSnippets.editorTitlePlaceholder' as any) as string}
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
              {t('settingsSnippets.editorCancel' as any)}
            </Button>
            <Button variant="primary" disabled={editor.body.trim().length === 0} onClick={saveEditor}>
              {t('settingsSnippets.editorSave' as any)}
            </Button>
          </div>
        </div>
      )}

      <ItemList>
        <ItemGroup
          title={t('settingsSnippets.presetsGroup' as any) as string}
          footer={t('settingsSnippets.presetsFooter' as any) as string}
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
                  aria-label={t('common.delete' as any) as string}
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
            title={t('settingsSnippets.addPreset' as any)}
            left={<Plus size={18} />}
            onClick={() => openEditor('preset')}
          />
        </ItemGroup>

        <ItemGroup
          title={t('settingsSnippets.commandsGroup' as any) as string}
          footer={t('settingsSnippets.commandsFooter' as any) as string}
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
                  aria-label={t('common.delete' as any) as string}
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
            title={t('settingsSnippets.addCommand' as any)}
            left={<Plus size={18} />}
            onClick={() => openEditor('command')}
          />
        </ItemGroup>
      </ItemList>
    </Page>
  );
}

// ===================================================================
// Notifications
// ===================================================================

const NOTIF_TYPES: NotifType[] = ['permission_request', 'reply_done', 'input_needed', 'error'];

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
        <Header title={t('notifications.title' as any) as string} onBack={() => navigate('/settings')} />
        <ItemList>
          <ItemGroup title={t('notifications.webOnly' as any) as string}>
            <Item title={t('notifications.unsupported' as any)} />
          </ItemGroup>
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
        title={t('notifications.title' as any) as string}
        subtitle={t('notifications.settingsSubtitle' as any) as string}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup
          title={t('notifications.browserNotifications' as any) as string}
          footer={
            denied
              ? (t('notifications.permissionDeniedHint' as any) as string)
              : (t('notifications.masterDescription' as any) as string)
          }
        >
          <Item
            title={t('notifications.enable' as any)}
            subtitle={prefs.enabled ? t('notifications.enabledOn' as any) : t('notifications.enabledOff' as any)}
            right={
              busy ? (
                <Spinner size={14} />
              ) : (
                <Toggle
                  checked={prefs.enabled}
                  disabled={denied}
                  onChange={toggleMaster}
                  label={t('notifications.enable' as any) as string}
                />
              )
            }
          />
        </ItemGroup>

        <ItemGroup
          title={t('notifications.types' as any) as string}
          footer={t('notifications.typesDescription' as any) as string}
        >
          {NOTIF_TYPES.map((type) => (
            <Item
              key={type}
              title={t(`notifications.type_${type}` as any)}
              subtitle={t(`notifications.type_${type}_desc` as any)}
              right={
                <Toggle
                  checked={prefs.types[type]}
                  disabled={!prefs.enabled}
                  onChange={(v) => setTypeEnabled(type, v)}
                  label={t(`notifications.type_${type}` as any) as string}
                />
              }
            />
          ))}
        </ItemGroup>

        <ItemGroup
          title={t('notifications.quietHours' as any) as string}
          footer={t('notifications.quietHoursDescription' as any) as string}
        >
          <Item
            title={t('notifications.quietHoursEnable' as any)}
            right={
              <Toggle
                checked={prefs.quietHours.enabled}
                disabled={!prefs.enabled}
                onChange={(v) => setQuietHours({ enabled: v })}
                label={t('notifications.quietHoursEnable' as any) as string}
              />
            }
          />
          {prefs.quietHours.enabled && (
            <>
              <Item
                title={t('notifications.quietHoursStart' as any)}
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
                title={t('notifications.quietHoursEnd' as any)}
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
    { key: 'today', label: t('usage.today' as any) as string },
    { key: '7days', label: t('usage.last7Days' as any) as string },
    { key: '30days', label: t('usage.last30Days' as any) as string },
  ];

  return (
    <Page>
      <Header
        title={t('settings.usage' as any) as string}
        subtitle={t('settings.usageSubtitle' as any) as string}
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
          <Spinner size={16} /> {t('common.loading' as any)}
        </div>
      ) : error || !totals ? (
        <div className="set-center">{t('usage.noData' as any)}</div>
      ) : totals.totalTokens === 0 ? (
        <div className="set-center">{t('usage.noData' as any)}</div>
      ) : (
        <>
          <div className="set-stat-row">
            <div className="set-stat">
              <span className="set-stat__label">{t('usage.totalTokens' as any)}</span>
              <span className="set-stat__value">{formatCompact(totals.totalTokens)}</span>
            </div>
            <div className="set-stat">
              <span className="set-stat__label">{t('usage.totalCost' as any)}</span>
              <span className="set-stat__value">${totals.totalCost.toFixed(2)}</span>
            </div>
          </div>

          <ItemGroup title={t('usage.usageOverTime' as any) as string}>
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

          <ItemGroup title={t('usage.byModel' as any) as string}>
            {Object.entries(totals.tokensByModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, tokens]) => (
                <Item
                  key={model}
                  title={model}
                  detail={`${formatCompact(tokens)} ${(t('usage.tokens' as any) as string).toLowerCase()}`}
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
      return t('diagnostics.statusConnected' as any);
    case 'connecting':
      return t('diagnostics.statusConnecting' as any);
    case 'error':
      return t('diagnostics.statusError' as any);
    case 'idle':
      return t('diagnostics.statusIdle' as any);
    default:
      return t('diagnostics.statusDisconnected' as any);
  }
}

function Diagnostics() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const socket = useSocketStatus();
  const realtime = useRealtimeStatus();
  const machines = useAllMachines({ includeOffline: true });

  const socketTone =
    socket.status === 'connected' ? 'connected' : socket.status === 'connecting' ? 'thinking' : 'offline';

  return (
    <Page>
      <Header
        title={t('diagnostics.title' as any) as string}
        subtitle={t('diagnostics.subtitle' as any) as string}
        onBack={() => navigate('/settings')}
      />
      <ItemList>
        <ItemGroup title={t('diagnostics.relay' as any) as string}>
          <Item
            title={t('diagnostics.serverSocket' as any)}
            subtitle={
              socket.lastConnectedAt
                ? `${t('diagnostics.lastConnected' as any)}: ${new Date(socket.lastConnectedAt).toLocaleString()}`
                : undefined
            }
            left={<StatusDot status={socketTone as any} pulse={socket.status === 'connected'} />}
            right={<span className="set-value">{statusLabel(t, socket.status)}</span>}
          />
          <Item
            title={t('diagnostics.realtime' as any)}
            right={<span className="set-value">{statusLabel(t, realtime)}</span>}
          />
        </ItemGroup>

        <ItemGroup title={t('diagnostics.machinesAndDaemons' as any) as string}>
          {machines.length === 0 ? (
            <Item title={t('diagnostics.noMachines' as any)} />
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
                      ? (t('diagnostics.cliMissing' as any, { cli: 'claude' } as any) as string)
                      : daemonStatus
                        ? `${t('diagnostics.daemonStatus' as any)}: ${daemonStatus}`
                        : undefined
                  }
                  detail={m.metadata?.host}
                  left={<StatusDot status={online ? 'connected' : 'offline'} />}
                  right={
                    <Badge tone={claudeMissing ? 'err' : online ? 'live' : 'muted'}>
                      {online ? t('diagnostics.online' as any) : t('diagnostics.offline' as any)}
                    </Badge>
                  }
                  onClick={() => navigate(`/machine/${m.id}`)}
                />
              );
            })
          )}
        </ItemGroup>
        <div className="set-note">{t('diagnostics.cliHint' as any)}</div>
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

  const usernameError = touched.u && username.trim().length === 0 ? (t('profile.username' as any) as string) : null;
  const passwordError =
    touched.p && password.length < MIN_PASSWORD
      ? (t('setPassword.errorTooShort' as any, { count: MIN_PASSWORD } as any) as string)
      : null;
  const confirmError =
    touched.c && confirm.length > 0 && confirm !== password ? (t('setPassword.errorMismatch' as any) as string) : null;

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
      toast.success(t('setPassword.success' as any) as string);
      setPassword('');
      setConfirm('');
      navigate('/settings/account');
    } catch (err: any) {
      if (err instanceof AccountAuthError && err.code === 'username-taken') {
        setServerError(t('signup.errorUsernameTaken' as any) as string);
      } else {
        setServerError(t('setPassword.errorSaveFailed' as any) as string);
      }
      setPassword('');
      setConfirm('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <Header title={t('settingsAccount.password' as any) as string} onBack={() => navigate('/settings')} />
      <div className="set-note">{t('setPassword.intro' as any)}</div>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <Input
          label={t('profile.username' as any) as string}
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onBlur={() => setTouched((s) => ({ ...s, u: true }))}
          error={usernameError}
        />
        <Input
          label={t('setPassword.passwordLabel' as any) as string}
          type="password"
          autoComplete="new-password"
          placeholder={t('setPassword.passwordPlaceholder' as any) as string}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, p: true }))}
          error={passwordError}
        />
        <Input
          label={t('setPassword.confirmLabel' as any) as string}
          type="password"
          autoComplete="new-password"
          placeholder={t('setPassword.confirmPlaceholder' as any) as string}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched((s) => ({ ...s, c: true }))}
          error={confirmError ?? serverError}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          {t('setPassword.save' as any)}
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
      <Route path="usage" element={<Usage />} />
      <Route path="diagnostics" element={<Diagnostics />} />
      <Route path="password" element={<Password />} />
    </Routes>
  );
}
