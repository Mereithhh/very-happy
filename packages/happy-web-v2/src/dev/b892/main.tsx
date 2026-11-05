/** B-892 prototype entry (not the app): see PrototypeApp. */
import '@/zodJitless';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@/styles/tokens.css';
import '@/styles/base.css';
import '@/styles/surfaces.css';
import '@/styles/dialog.css';
import { ThemeProvider, ToastProvider } from '@/ui';
import { ModalProvider } from '@/modal';
import { AuthProvider } from '@/auth/AuthContext';
import { PrototypeApp } from './PrototypeApp';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider><ToastProvider><ModalProvider><AuthProvider initialCredentials={null}><PrototypeApp /></AuthProvider></ModalProvider></ToastProvider></ThemeProvider>,
);
