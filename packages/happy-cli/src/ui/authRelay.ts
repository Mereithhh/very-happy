const DEFAULT_SERVER_URL = 'https://veryhappy.dev';
const LEGACY_CLOUD_SERVER_URL = 'https://happy.mereith.com';
const CLOUD_SERVER_URLS = [DEFAULT_SERVER_URL, LEGACY_CLOUD_SERVER_URL] as const;

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
  // access.key predates issuer metadata. It is safe to keep using those
  // credentials only on the two origins that identify the same managed Very
  // Happy Cloud deployment. This preserves existing installs during the
  // veryhappy.dev migration without weakening the fail-closed rule for an
  // arbitrary self-hosted relay.
  if (CLOUD_SERVER_URLS.some((cloudUrl) => sameRelay(configuredServerUrl, cloudUrl))) {
    return undefined;
  }
  return `These credentials predate relay tracking, so they cannot be safely reused with ${configuredServerUrl}.`;
}
