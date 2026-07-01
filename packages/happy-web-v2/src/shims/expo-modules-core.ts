// web shim for expo-modules-core: no native modules in the browser.
export function requireOptionalNativeModule(_name: string): null {
  return null;
}
export function requireNativeModule(_name: string): never {
  throw new Error('requireNativeModule is not available on web');
}
export class EventEmitter {
  addListener() {
    return { remove() {} };
  }
  removeAllListeners() {}
  emit() {}
}
export class NativeModule {}
export class SharedObject {}

export class CodedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class UnavailabilityError extends CodedError {
  constructor(moduleName: string, propertyName: string) {
    super(
      'ERR_UNAVAILABLE',
      `The method or property ${moduleName}.${propertyName} is not available on web.`,
    );
  }
}

export interface EventSubscription {
  remove(): void;
}

export const uuid = {
  v4(): string {
    return crypto.randomUUID();
  },
  v5(name: string, _namespace: string | number[]): string {
    return crypto.randomUUID() + ':' + name;
  },
};

export class Platform {
  static OS = 'web';
}

export function requireNativeViewManager() {
  return null;
}
