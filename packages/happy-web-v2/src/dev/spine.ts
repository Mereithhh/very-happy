/**
 * P1 data-spine smoke harness. Imported by main.tsx so the data layer is in the
 * build graph and the encryption/sync/socket stack is exercised end-to-end with
 * no UI. Use from the browser console:
 *
 *   await vhLogin('username', 'password')   // password login → encryption → socket → sync
 *   vhStorage.getState().sessions           // inspect synced sessions
 *
 * Removed once P2 wires the real login + sessions UI.
 */
import { loginWithPassword } from '@/auth/passwordUnlock';
import { TokenStorage } from '@/auth/tokenStorage';
import { syncCreate, sync } from '@/sync/sync';
import { storage } from '@/sync/storage';

async function vhLogin(username: string, password: string) {
  console.log('[spine] logging in as', username);
  const creds = await loginWithPassword(username, password);
  console.log('[spine] got credentials, token len', creds.token.length);
  await TokenStorage.setCredentials(creds);
  await syncCreate(creds);
  console.log('[spine] sync created. sessions:', storage.getState().sessions);
  return storage.getState();
}

if (typeof window !== 'undefined') {
  (window as any).vhLogin = vhLogin;
  (window as any).vhStorage = storage;
  (window as any).vhSync = sync;
  console.log('[spine] ready — call vhLogin(user, pass) in console');
}
