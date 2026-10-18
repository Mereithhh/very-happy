/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __DEFAULT_SERVER_URL__: string;
declare const __APP_VERSION__: string;
declare const __DEV__: boolean;

interface Window {
  __HAPPY_CONFIG__?: {
    serverUrl?: string;
    buildCommitSha?: string;
    buildCommitTimestamp?: string;
    /** B-624 white-label (standalone BRAND_NAME / BRAND_LOGO_URL / WEB_LANDING). */
    brand?: { name?: string; logoUrl?: string };
    landing?: boolean;
  };
}
