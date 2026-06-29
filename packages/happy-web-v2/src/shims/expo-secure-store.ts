// web shim for expo-secure-store. NOTE: browser localStorage is NOT hardware-secure;
// acceptable under the server-trusted model (see SKILL). Tokens already live here.
const PREFIX = 'securestore:';

export async function getItemAsync(key: string): Promise<string | null> {
  return localStorage.getItem(PREFIX + key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  localStorage.setItem(PREFIX + key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key);
}

export async function isAvailableAsync(): Promise<boolean> {
  return typeof localStorage !== 'undefined';
}
