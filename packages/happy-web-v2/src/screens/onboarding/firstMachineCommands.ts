const CLOUD_ORIGIN = 'https://veryhappy.dev';
export const CLOUD_BOOTSTRAP_COMMAND = `(
  set -eu
  vh_installer=$(mktemp)
  trap 'rm -f "$vh_installer"' \\
    EXIT HUP INT TERM
  curl -fsSL \\
    https://veryhappy.dev/install.sh \\
    -o "$vh_installer"
  sh "$vh_installer"
)`;

function httpOrigin(value: string, fallback: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.origin;
  } catch {
    // Fall through to the safe public Cloud fallback.
  }
  return fallback;
}

export type FirstMachineCommands = {
  login: string;
  daemon: string;
  loginPowerShell?: string;
  daemonPowerShell?: string;
};

function firstMachineEnvironment(serverUrl: string, webappUrl: string) {
  const relayOrigin = httpOrigin(serverUrl, CLOUD_ORIGIN);
  const webappOrigin = httpOrigin(webappUrl, CLOUD_ORIGIN);
  if (relayOrigin === CLOUD_ORIGIN && webappOrigin === CLOUD_ORIGIN) {
    return { environment: '', powerShellEnvironment: '' };
  }
  const profile = new URL(webappOrigin).host.toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'self-hosted';
  return {
    environment: `export HAPPY_HOME_DIR="$HOME/.very-happy-${profile}"\nexport HAPPY_SERVER_URL='${relayOrigin}'\nexport HAPPY_WEBAPP_URL='${webappOrigin}'`,
    powerShellEnvironment: `$env:HAPPY_HOME_DIR="$HOME/.very-happy-${profile}"\n$env:HAPPY_SERVER_URL='${relayOrigin}'\n$env:HAPPY_WEBAPP_URL='${webappOrigin}'`,
  };
}

export function firstMachineBootstrapCommand(serverUrl: string, webappUrl: string): string {
  const { environment } = firstMachineEnvironment(serverUrl, webappUrl);
  return environment ? `${environment}\n${CLOUD_BOOTSTRAP_COMMAND}` : CLOUD_BOOTSTRAP_COMMAND;
}

export function firstMachineCommands(serverUrl: string, webappUrl: string): FirstMachineCommands {
  const { environment, powerShellEnvironment } = firstMachineEnvironment(serverUrl, webappUrl);
  if (!environment) {
    return { login: 'very-happy auth login', daemon: 'very-happy daemon start' };
  }
  return {
    login: `${environment}\nvery-happy auth login`,
    daemon: `${environment}\nvery-happy daemon start`,
    loginPowerShell: `${powerShellEnvironment}\nvery-happy auth login`,
    daemonPowerShell: `${powerShellEnvironment}\nvery-happy daemon start`,
  };
}
