import { useRef } from 'react';

/** Retain the last open view while its host is hidden, never across identities. */
export function useRetainedWorkspace<T>(identity: string, value: T | null): T | null {
  const retained = useRef<{ identity: string; value: T | null }>({ identity, value });
  if (retained.current.identity !== identity || value !== null) {
    retained.current = { identity, value };
  }
  return retained.current.value;
}
