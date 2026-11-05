/** B-892 prototype build: one self-contained HTML, no network. Output: VH_B892_OUT. */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import base from './vite.config';

function inlineEverything(): Plugin {
  return {
    name: 'b892-inline',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') throw new Error('no html');
      let page = String(html.source);
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          const tag = new RegExp(`<link[^>]*${file.fileName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^>]*>`);
          if (!tag.test(page)) throw new Error(`css tag not found: ${file.fileName}`);
          page = page.replace(tag, () => `<style>${String(file.source)}</style>`);
          delete bundle[file.fileName];
        } else if (file.type === 'chunk') {
          const tag = new RegExp(`<script[^>]*${file.fileName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^>]*></script>`);
          if (!tag.test(page)) throw new Error(`script tag not found: ${file.fileName}`);
          page = page.replace(tag, '');
          page = page.replace('</body>', () => `<script type="module">${file.code.replaceAll('__VITE_PRELOAD__', 'void 0').replace(/<\/script/g, '<\\/script')}</script></body>`);
          delete bundle[file.fileName];
        }
      }
      html.source = page;
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  resolve: base.resolve,
  define: { ...base.define, __DEFAULT_SERVER_URL__: JSON.stringify('http://127.0.0.1:9') },
  plugins: [react(), inlineEverything()],
  publicDir: false,
  build: {
    outDir: process.env.VH_B892_OUT ?? 'dist-b892',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100_000,
    rollupOptions: { input: 'prototype-b892.html', output: { inlineDynamicImports: true } },
  },
});
