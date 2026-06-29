import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Default server target; overridable at runtime via window.__HAPPY_CONFIG__.serverUrl
// (injected into index.html on deploy, mirroring the v1 HAPPY_INJECT_HTML_CONFIG path).
const DEFAULT_SERVER_URL = 'https://happy.mereith.com';
const APP_VERSION = process.env.VH_VERSION ?? '2.0.0';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: process.env.VH_BASE ?? '/',
  plugins: [react()],
  resolve: {
    // Metro-style platform resolution: prefer `.web.ts(x)` so the existing web
    // forks (libsodium.lib.web, aes.web, uploadFormFile.web, …) win over native.
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.json',
    ],
    alias: {
      '@': r('./src'),
      // RN + expo native modules → minimal web shims (see src/shims).
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
    // some npm deps reference process.env.NODE_ENV; keep a safe fallback object.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'process.env': '{}',
  },
  server: {
    port: 8082,
    host: true,
  },
});
