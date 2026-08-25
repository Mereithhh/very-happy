import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldShowFirstRun, shouldShowWorkspaceGuide } from './firstRun';
import { CLOUD_BOOTSTRAP_COMMAND, firstMachineBootstrapCommand, firstMachineCommands } from './firstMachineCommands';

describe('shouldShowFirstRun', () => {
  it('waits for hydration before deciding the account is new', () => {
    expect(shouldShowFirstRun(false, 0)).toBe(false);
  });

  it('shows only when the hydrated account has no registered machine', () => {
    expect(shouldShowFirstRun(true, 0)).toBe(true);
    expect(shouldShowFirstRun(true, 1)).toBe(false);
  });
});

describe('shouldShowWorkspaceGuide', () => {
  const layout = readFileSync(new URL('../AppLayout.tsx', import.meta.url), 'utf8');

  it('shows the mobile guide only for a hydrated, connected, empty workspace', () => {
    expect(shouldShowWorkspaceGuide(false, 1, 0, 0)).toBe(false);
    expect(shouldShowWorkspaceGuide(true, 0, 0, 0)).toBe(false);
    expect(shouldShowWorkspaceGuide(true, 1, 0, 0)).toBe(true);
    expect(shouldShowWorkspaceGuide(true, 1, 1, 0)).toBe(false);
    expect(shouldShowWorkspaceGuide(true, 1, 0, 1)).toBe(false);
    expect(layout).toContain('atRoot && !firstRun && !workspaceGuide');
  });
});

describe('first-machine command sequence', () => {
  const screen = readFileSync(new URL('./FirstRunScreen.tsx', import.meta.url), 'utf8');
  const english = readFileSync(new URL('../../text/_default.ts', import.meta.url), 'utf8');
  const chinese = readFileSync(new URL('../../text/translations/zh-Hans.ts', import.meta.url), 'utf8');

  it('makes daemon startup the final copyable step before the workspace takes over', () => {
    expect(firstMachineBootstrapCommand('https://veryhappy.dev', 'https://veryhappy.dev')).toBe(CLOUD_BOOTSTRAP_COMMAND);
    expect(firstMachineCommands('https://veryhappy.dev', 'https://veryhappy.dev')).toEqual({
      login: 'very-happy auth login',
      daemon: 'very-happy daemon start',
    });
    expect(screen).toContain('<Command value={bootstrapCommand} />');
    expect(screen).toContain('<ShellCommands posix={commands.daemon} powershell={commands.daemonPowerShell} />');
    expect(screen.indexOf("t('onboarding.linkTitle')")).toBeLessThan(screen.indexOf("t('onboarding.daemonTitle')"));
    expect(screen).not.toContain("t('onboarding.startTitle')");
    expect(english).toContain('this page moves to the workspace; choose New session there');
    expect(chinese).toContain('本页会进入工作区；接着点击“新建会话”');
  });

  it('copies the current self-hosted origin into both auth and daemon commands', () => {
    const commands = firstMachineCommands('https://api.example.com:9443/v1', 'https://relay.example.com:8443/path');
    expect(commands.login).toBe("export HAPPY_HOME_DIR=\"$HOME/.very-happy-relay.example.com-8443\"\nexport HAPPY_SERVER_URL='https://api.example.com:9443'\nexport HAPPY_WEBAPP_URL='https://relay.example.com:8443'\nvery-happy auth login");
    expect(commands.daemon).toBe("export HAPPY_HOME_DIR=\"$HOME/.very-happy-relay.example.com-8443\"\nexport HAPPY_SERVER_URL='https://api.example.com:9443'\nexport HAPPY_WEBAPP_URL='https://relay.example.com:8443'\nvery-happy daemon start");
    expect(commands.loginPowerShell).toContain("$env:HAPPY_SERVER_URL='https://api.example.com:9443'");
    expect(commands.daemonPowerShell).toContain('very-happy daemon start');
    const bootstrap = firstMachineBootstrapCommand('https://api.example.com:9443/v1', 'https://relay.example.com:8443/path');
    expect(bootstrap).toContain("export HAPPY_SERVER_URL='https://api.example.com:9443'");
    expect(bootstrap).toContain("export HAPPY_WEBAPP_URL='https://relay.example.com:8443'");
    expect(bootstrap).toContain(CLOUD_BOOTSTRAP_COMMAND);
    expect(firstMachineCommands('not a URL', 'also bad')).toEqual(firstMachineCommands('https://veryhappy.dev', 'https://veryhappy.dev'));
    expect(firstMachineBootstrapCommand('not a URL', 'also bad')).toBe(CLOUD_BOOTSTRAP_COMMAND);
  });

  it('does not tell users to choose a removed authentication channel', () => {
    expect(english).toContain('the CLI also tries to open it');
    expect(chinese).toContain('CLI 也会尝试自动打开');
    expect(english).not.toContain('choose Web Browser');
    expect(chinese).not.toContain('选择「Web Browser」');
  });

  it('states agent and tmux prerequisites before pairing', () => {
    expect(english).toContain('Node.js 20.19+ within 20.x, 22.13+ within 22.x, or 24+');
    expect(english).not.toContain('24+ LTS');
    expect(english).toContain('Structured Claude uses the bundled Agent SDK');
    expect(english).toContain('other agent and native terminal paths need their local command');
    expect(chinese).toContain('结构化 Claude 使用内置 Agent SDK');
    expect(english).toContain('npm is included');
    expect(chinese).toContain('会自带 npm');
    expect(screen).toContain('https://nodejs.org/en/download');
    expect(english).toContain("terminalSubtitle: 'Open a terminal on a connected machine'");
    expect(english).not.toContain("terminalSubtitle: 'Open a terminal (tmux)");
  });

  it('keeps command copy targets large enough for touch', () => {
    const styles = readFileSync(new URL('./firstRun.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.fr-command button \{[^}]*width: 44px;[^}]*height: 44px;/s);
    expect(styles).toMatch(/\.fr-command code \{[^}]*white-space: pre-wrap;[^}]*line-height: 1\.55;/s);
  });

  it('centers the first-run content column without centering its text', () => {
    const styles = readFileSync(new URL('./firstRun.css', import.meta.url), 'utf8');
    expect(styles).toMatch(/\.fr-page \{[^}]*align-items: center;/s);
    expect(styles).toMatch(/\.fr-hero \{ width: min\(100%, 720px\); \}/);
    expect(styles).toMatch(/\.fr-actions \{ width: min\(100%, 720px\);/);
    expect(styles).not.toMatch(/\.fr-page \{[^}]*text-align: center;/s);
  });
});
