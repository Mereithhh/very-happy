const DEFAULT_SERVER_URL = 'https://happy.mereith.com';

function sameRelay(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
  }
}

export function credentialRelayProblem(
  credentialServerUrl: string | undefined,
  configuredServerUrl: string,
): string | undefined {
  if (credentialServerUrl) {
    return sameRelay(credentialServerUrl, configuredServerUrl)
      ? undefined
      : `Credentials belong to ${credentialServerUrl}, but the active relay is ${configuredServerUrl}.`;
  }
  if (sameRelay(configuredServerUrl, DEFAULT_SERVER_URL)) return undefined;
  return `These credentials predate relay tracking, so they cannot be safely reused with ${configuredServerUrl}.`;
}
