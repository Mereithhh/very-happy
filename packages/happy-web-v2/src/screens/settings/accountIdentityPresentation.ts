export type AccountIdentityState =
  | 'methods-loading'
  | 'methods-error'
  | 'linked-config-loading'
  | 'linked-config-error'
  | 'linked-enabled'
  | 'linked-disabled'
  | 'unlinked-config-loading'
  | 'unlinked-config-error'
  | 'unlinked-enabled'
  | 'unlinked-disabled';

export function accountIdentityState(input: {
  methodsLoaded: boolean;
  methodsError: boolean;
  connected: boolean;
  configEnabled: boolean | null;
  configError: boolean;
}): AccountIdentityState {
  if (input.methodsError) return 'methods-error';
  if (!input.methodsLoaded) return 'methods-loading';
  const prefix = input.connected ? 'linked' : 'unlinked';
  if (input.configError) return `${prefix}-config-error`;
  if (input.configEnabled === null) return `${prefix}-config-loading`;
  return `${prefix}-${input.configEnabled ? 'enabled' : 'disabled'}`;
}

export function accountIdentityAction(state: AccountIdentityState): 'retry-methods' | 'retry-config' | 'link' | null {
  if (state === 'methods-error') return 'retry-methods';
  if (state === 'linked-config-error' || state === 'unlinked-config-error') return 'retry-config';
  if (state === 'unlinked-enabled') return 'link';
  return null;
}
