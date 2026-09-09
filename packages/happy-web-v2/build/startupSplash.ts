import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { readThemePreference } from '../src/ui/themePreference';

const read = (path:string) => readFileSync(new URL(path,import.meta.url),'utf8');
export function startupSplash(): Plugin {
  return {
    name:'very-happy-startup-splash',
    transformIndexHtml: {
      order:'pre',
      handler(html) {
        return renderStartupSplash(html);
      },
    },
  };
}

export function renderStartupSplash(html:string): string {
  const tokens=read('../src/styles/tokens.css');
  const css=read('../src/ui/startupLoader.css');
  const artwork=read('../src/ui/startupArtwork.html');
  const themeScript=`const preference=(${readThemePreference.toString()})();if(preference==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',preference);`;
  return html.replace('<!-- vh-startup-style -->',`<style>${(tokens+'\n'+css).replace(/\/\*[\s\S]*?\*\//g,'')}</style><script>${themeScript}</script>`)
    .replace('<!-- vh-startup-artwork -->',artwork);
}
