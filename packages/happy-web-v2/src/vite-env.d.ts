/// <reference types="vite/client" />

declare const __DEFAULT_SERVER_URL__: string;
declare const __APP_VERSION__: string;

interface Window {
  __HAPPY_CONFIG__?: { serverUrl?: string; buildCommitSha?: string; buildCommitTimestamp?: string };
}
