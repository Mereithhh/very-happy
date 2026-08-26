import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// Default server target; overridable at runtime via window.__HAPPY_CONFIG__.serverUrl
// (injected into index.html on deploy, mirroring the v1 HAPPY_INJECT_HTML_CONFIG path).
const DEFAULT_SERVER_URL = process.env.VH_SERVER_URL ?? 'https://veryhappy.dev';
const APP_VERSION = process.env.VH_VERSION ?? '2.0.0';
const BASE = process.env.VH_BASE ?? '/';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: 'Very Happy',
        short_name: 'Very Happy',
        description: 'An open agent workspace for your machines. Work anywhere and keep the thread.',
        theme_color: '#06080c',
        background_color: '#06080c',
        display: 'standalone',
        scope: BASE,
        start_url: BASE,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Visible half of Web Push: generateSW emits the worker,
        // so push/notificationclick handlers live in public/push-sw.js and
        // are imported here. Without this, pushes arrive and show NOTHING.
        importScripts: ['push-sw.js'],
        // SPA: serve index.html for navigations; never precache the API/socket.
        navigateFallback: `${BASE}index.html`,
        navigateFallbackDenylist: [/^\/v1\//, /^\/health/],
        // Keep install tiny. Pre-caching every authenticated chunk made a fresh
        // anonymous landing silently download ~6 MB in the background. Hashed
        // assets are cached on first use instead, so public visitors fetch only
        // the public shell and authenticated users build an offline cache as
        // they use the app.
        globPatterns: ['index.html', 'manifest.webmanifest', 'registerSW.js'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.(?:js|css|woff|woff2)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'very-happy-assets-v1',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 180, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    extensions: [
      '.web.tsx', '.web.ts', '.web.jsx', '.web.js',
      '.tsx', '.ts', '.jsx', '.js', '.json',
    ],
    alias: {
      '@': r('./src'),
      'react-native': r('./src/shims/react-native.ts'),
      'expo-crypto': r('./src/shims/expo-crypto.ts'),
      'expo-constants': r('./src/shims/expo-constants.ts'),
      'expo-secure-store': r('./src/shims/expo-secure-store.ts'),
      'expo-localization': r('./src/shims/expo-localization.ts'),
      'expo-modules-core': r('./src/shims/expo-modules-core.ts'),
      'expo-application': r('./src/shims/expo-misc.ts'),
      'expo-device': r('./src/shims/expo-misc.ts'),
      'expo-updates': r('./src/shims/expo-misc.ts'),
      'expo-notifications': r('./src/shims/expo-notifications.ts'),
      '@expo/vector-icons': r('./src/shims/expo-vector-icons.tsx'),
    },
  },
  define: {
    __DEFAULT_SERVER_URL__: JSON.stringify(DEFAULT_SERVER_URL),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env': '{}',
  },
  build: {
    rollupOptions: {
      output: {
        // Salt filenames with the app version so a new release always mints fresh
        // asset URLs — even for content-stable chunks (libsodium). Guards against
        // a poisoned immutable cache surviving a redeploy.
        entryFileNames: `assets/[name]-[hash]-${APP_VERSION.replace(/\W/g, '')}.js`,
        chunkFileNames: `assets/[name]-[hash]-${APP_VERSION.replace(/\W/g, '')}.js`,
        assetFileNames: `assets/[name]-[hash]-${APP_VERSION.replace(/\W/g, '')}[extname]`,
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          crypto: ['libsodium-wrappers', 'tweetnacl'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
        },
      },
    },
  },
  server: {
    port: 8082,
    host: true,
    // Dev-only: proxy the API + socket to the live server so the app talks
    // same-origin to localhost (no cross-origin / Clash / wss quirks). In dev the
    // app uses a same-origin serverUrl (see sync/serverConfig getServerUrl), so
    // these paths get forwarded here. Ignored entirely by `vite build`.
    proxy: {
      '/v1': { target: DEFAULT_SERVER_URL, changeOrigin: true, secure: true, ws: true },
      '/v2': { target: DEFAULT_SERVER_URL, changeOrigin: true, secure: true },
      '/v3': { target: DEFAULT_SERVER_URL, changeOrigin: true, secure: true },
      '/health': { target: DEFAULT_SERVER_URL, changeOrigin: true, secure: true },
    },
  },
});
