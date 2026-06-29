// web v2: analytics disabled (no posthog-react-native — it bundles react-navigation
// autocapture). All call sites use `tracking?.x`, so null is a safe no-op. A
// posthog-js integration can be added later if desired.
export const tracking = null as null | {
  identify: (id: string, props?: Record<string, unknown>) => void;
  capture: (event: string, props?: Record<string, unknown>) => void;
  reset: () => void;
};
