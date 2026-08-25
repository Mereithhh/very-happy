export type GoogleButtonState = {
  enabled: boolean;
  failed: boolean;
  attempt: number;
};

export type GoogleButtonEvent = 'rendering' | 'rendered' | 'unavailable' | 'retry';
export type GoogleAvailability = 'checking' | 'configured' | 'absent';
export type GoogleButtonTheme = 'outline' | 'outline_dark';

export const initialGoogleButtonState: GoogleButtonState = {
  enabled: false,
  failed: false,
  attempt: 0,
};

export function shouldShowGoogleBlock(
  availability: GoogleAvailability,
  required: boolean,
  failed: boolean,
): boolean {
  return required || failed || availability !== 'absent';
}

export function googleButtonTheme(resolvedTheme: 'dark' | 'light'): GoogleButtonTheme {
  return resolvedTheme === 'dark' ? 'outline_dark' : 'outline';
}

/** Pure state transition so the required loading/failure/retry contract stays regression-tested. */
export function reduceGoogleButtonState(state: GoogleButtonState, event: GoogleButtonEvent): GoogleButtonState {
  switch (event) {
    case 'rendering':
      // Keep an already-rendered slot visible while a fresh challenge/theme is
      // being installed. The iframe may be empty briefly, but the form must
      // not collapse and re-expand around it.
      return { ...state, failed: false };
    case 'rendered':
      return { ...state, enabled: true, failed: false };
    case 'unavailable':
      return { ...state, enabled: false, failed: true };
    case 'retry':
      return { enabled: false, failed: false, attempt: state.attempt + 1 };
  }
}
