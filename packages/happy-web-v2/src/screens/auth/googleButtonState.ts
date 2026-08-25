export type GoogleButtonState = {
  enabled: boolean;
  failed: boolean;
  attempt: number;
};

export type GoogleButtonEvent = 'rendering' | 'rendered' | 'unavailable' | 'retry';

export const initialGoogleButtonState: GoogleButtonState = {
  enabled: false,
  failed: false,
  attempt: 0,
};

/** Pure state transition so the required loading/failure/retry contract stays regression-tested. */
export function reduceGoogleButtonState(state: GoogleButtonState, event: GoogleButtonEvent): GoogleButtonState {
  switch (event) {
    case 'rendering':
      return { ...state, enabled: false, failed: false };
    case 'rendered':
      return { ...state, enabled: true, failed: false };
    case 'unavailable':
      return { ...state, enabled: false, failed: true };
    case 'retry':
      return { enabled: false, failed: false, attempt: state.attempt + 1 };
  }
}
