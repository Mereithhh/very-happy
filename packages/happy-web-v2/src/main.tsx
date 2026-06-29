import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';

import './styles/tokens.css';
import './styles/base.css';

import './dev/spine.ts';
import { AppRoot } from './app/AppRoot.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);

// remove the pre-paint splash once React has mounted
const splash = document.getElementById('vh-splash');
if (splash) {
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 300);
}
