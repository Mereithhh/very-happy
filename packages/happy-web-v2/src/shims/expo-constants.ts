// web shim for expo-constants. version/runtimeVersion come from build define.
const APP_VERSION = __APP_VERSION__;

const Constants = {
  expoConfig: {
    version: APP_VERSION,
    runtimeVersion: APP_VERSION,
    ios: { bundleIdentifier: 'com.mereith.veryhappy' },
    android: { package: 'com.mereith.veryhappy' },
    extra: {} as Record<string, unknown>,
  },
};

export default Constants;
