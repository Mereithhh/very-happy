// web v2: app config comes from build-time defines + an optional runtime
// window.__HAPPY_CONFIG__ blob injected into index.html on deploy (mirrors the
// v1 HAPPY_INJECT_HTML_CONFIG path). No expo-constants / native manifest.

export interface AppConfig {
  postHogKey?: string;
  revenueCatAppleKey?: string;
  revenueCatGoogleKey?: string;
  revenueCatStripeKey?: string;
  elevenLabsAgentId?: string;
  consoleLoggingDefault?: boolean;
  serverUrl?: string;
  buildCommitSha?: string;
  buildCommitTimestamp?: string;
}

export function loadAppConfig(): AppConfig {
  const runtime = (globalThis as any).__HAPPY_CONFIG__ ?? {};
  return {
    serverUrl: runtime.serverUrl ?? __DEFAULT_SERVER_URL__,
    buildCommitSha: runtime.buildCommitSha,
    buildCommitTimestamp: runtime.buildCommitTimestamp,
    consoleLoggingDefault: false,
  };
}
