/**
 * Minimal web shim for the handful of non-UI `react-native` APIs the ported data
 * layer touches: Platform, AppState, Linking, Dimensions, useWindowDimensions.
 * Aliased in vite.config.ts so `from 'react-native'` resolves here — no source edits.
 */
import { useEffect, useState } from 'react';

export const Platform = {
  OS: 'web' as 'web' | 'ios' | 'android',
  select<T>(specifics: { web?: T; default?: T; ios?: T; android?: T; native?: T }): T | undefined {
    if ('web' in specifics) return specifics.web;
    return specifics.default;
  },
  Version: 0 as number | string,
};

export type AppStateStatus = 'active' | 'background' | 'inactive';

type AppStateListener = (status: AppStateStatus) => void;

function currentStatus(): AppStateStatus {
  if (typeof document === 'undefined') return 'active';
  const visible = document.visibilityState === 'visible';
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return visible && focused ? 'active' : 'background';
}

class AppStateImpl {
  get currentState(): AppStateStatus {
    return currentStatus();
  }

  addEventListener(type: 'change', listener: AppStateListener): { remove: () => void } {
    if (type !== 'change' || typeof window === 'undefined') {
      return { remove: () => {} };
    }
    let last = currentStatus();
    const handler = () => {
      const next = currentStatus();
      if (next !== last) {
        last = next;
        listener(next);
      }
    };
    document.addEventListener('visibilitychange', handler);
    window.addEventListener('focus', handler);
    window.addEventListener('blur', handler);
    return {
      remove() {
        document.removeEventListener('visibilitychange', handler);
        window.removeEventListener('focus', handler);
        window.removeEventListener('blur', handler);
      },
    };
  }
}

export const AppState = new AppStateImpl();

export const Linking = {
  async openURL(url: string): Promise<void> {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  },
  async canOpenURL(_url: string): Promise<boolean> {
    return true;
  },
  async getInitialURL(): Promise<string | null> {
    return typeof window !== 'undefined' ? window.location.href : null;
  },
  addEventListener() {
    return { remove() {} };
  },
};

export const Dimensions = {
  get(_dim: 'window' | 'screen') {
    if (typeof window === 'undefined') return { width: 0, height: 0, scale: 1, fontScale: 1 };
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio || 1,
      fontScale: 1,
    };
  },
  addEventListener() {
    return { remove() {} };
  },
};

// Some transitive RN libraries (e.g. react-native-device-info) import these at
// module top-level even on web. Provide inert versions so they load their web path.
export const NativeModules: Record<string, any> = {};

export class NativeEventEmitter {
  addListener(_event: string, _cb: (...args: any[]) => void) {
    return { remove() {} };
  }
  removeAllListeners(_event?: string) {}
  removeSubscription() {}
  emit() {}
}

export const TurboModuleRegistry = {
  get(_name: string) {
    return null;
  },
  getEnforcing(_name: string) {
    return null;
  },
};

export const NativeEventEmitterModule = NativeEventEmitter;

export function useWindowDimensions() {
  const [dims, setDims] = useState(() => Dimensions.get('window'));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setDims(Dimensions.get('window'));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return dims;
}
