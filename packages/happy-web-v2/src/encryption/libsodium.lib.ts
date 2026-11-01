import sodium from '@more-tech/react-native-libsodium';

// The native module is ready on import; kept for parity with the web build.
export const sodiumReady: () => Promise<void> = () => Promise.resolve();

export default sodium;
